import { ExpoConfig } from '@expo/config';
import { Flags } from '@oclif/core';

import EasCommand from '../../commandUtils/EasCommand';
import { ExpoGraphqlClient } from '../../commandUtils/context/contextUtils/createGraphqlClient';
import { EasNonInteractiveAndJsonFlags } from '../../commandUtils/flags';
import Log from '../../log';
import { enforceRollBackToEmbeddedUpdateSupportAsync } from '../../project/projectUtils';
import { UpdatePublishPlatform, getUpdateMessageForCommandAsync } from '../../project/publish';
import { confirmAsync } from '../../prompts';
import { scheduleUpdateGroupDeletionAsync } from '../../update/delete';
import {
  UpdateToRepublish,
  getOrAskUpdateMessageAsync,
  getUpdateGroupAsync,
  getUpdateGroupOrAskForUpdateGroupAsync,
  republishAsync,
} from '../../update/republish';
import { publishRollBackToEmbeddedUpdateAsync } from '../../update/roll-back-to-embedded';
import { CodeSigningInfo, getCodeSigningInfoAsync } from '../../utils/code-signing';
import { enableJsonOutput } from '../../utils/json';
import { pollForBackgroundJobReceiptAsync } from '../../utils/pollForBackgroundJobReceiptAsync';
import { Client } from '../../vcs/vcs';

type RolloutUpdate = UpdateToRepublish & {
  rolloutPercentage: NonNullable<UpdateToRepublish['rolloutPercentage']>;
};

type RolloutUpdateWithControlUpdate = RolloutUpdate & {
  rolloutControlUpdate: NonNullable<UpdateToRepublish['rolloutControlUpdate']>;
};

type UpdateRevertUpdateRolloutRawFlags = {
  branch?: string;
  channel?: string;
  group?: string;
  message?: string;
  'private-key-path'?: string;
  'non-interactive': boolean;
  json?: boolean;
};

type UpdateRevertUpdateRolloutFlags = {
  branchName?: string;
  channelName?: string;
  groupId?: string;
  updateMessage?: string;
  privateKeyPath?: string;
  nonInteractive: boolean;
  json: boolean;
};

export default class UpdateRevertUpdateRollout extends EasCommand {
  static override description = 'revert a rollout update for a project';

  static override flags = {
    channel: Flags.string({
      description: 'Channel name to select an update group to revert the rollout update from',
      exclusive: ['branch', 'group'],
    }),
    branch: Flags.string({
      description: 'Branch name to select an update group to revert the rollout update from',
      exclusive: ['channel', 'group'],
    }),
    group: Flags.string({
      description: 'Rollout update group ID to revert',
      exclusive: ['branch', 'channel'],
    }),
    message: Flags.string({
      char: 'm',
      description: 'Short message describing the revert',
      required: false,
    }),
    'private-key-path': Flags.string({
      description: `File containing the PEM-encoded private key corresponding to the certificate in expo-updates' configuration. Defaults to a file named "private-key.pem" in the certificate's directory. Only relevant if you are using code signing: https://docs.expo.dev/eas-update/code-signing/`,
      required: false,
    }),
    ...EasNonInteractiveAndJsonFlags,
  };

  static override contextDefinition = {
    ...this.ContextOptions.ProjectConfig,
    ...this.ContextOptions.LoggedIn,
    ...this.ContextOptions.Vcs,
  };

  async runAsync(): Promise<void> {
    const { flags: rawFlags } = await this.parse(UpdateRevertUpdateRollout);
    const flags = this.sanitizeFlags(rawFlags);

    const {
      privateProjectConfig: { exp, projectId, projectDir },
      loggedIn: { graphqlClient },
      vcsClient,
    } = await this.getContextAsync(UpdateRevertUpdateRollout, {
      nonInteractive: flags.nonInteractive,
      withServerSideEnvironment: null,
    });

    if (flags.json) {
      enableJsonOutput();
    }

    const codeSigningInfo = await getCodeSigningInfoAsync(exp, flags.privateKeyPath);

    const existingUpdates = await getUpdateGroupOrAskForUpdateGroupAsync(
      graphqlClient,
      projectId,
      flags
    );
    const rolloutUpdateGroup = existingUpdates.filter(updateGroupIsRolloutUpdate);

    if (existingUpdates.length === 0) {
      throw new Error(`There are no published rollout updates found`);
    }
    if (rolloutUpdateGroup.length === 0) {
      throw new Error(
        `There are no rollout updates on branch "${existingUpdates[0].branchName}" with group ID "${
          flags.groupId ? flags.groupId : rolloutUpdateGroup[0].groupId
        }".`
      );
    }

    const rolloutUpdateGroupWithControlUpdates: RolloutUpdateWithControlUpdate[] =
      rolloutUpdateGroup.filter(updateGroupIsUpdateGroupWithControlUpdate);
    if (rolloutUpdateGroupWithControlUpdates.length === rolloutUpdateGroup.length) {
      await this.deleteRolloutAndRepublishControlUpdateGroupAsync({
        graphqlClient,
        exp,
        projectId,
        rolloutUpdateGroupWithControlUpdates,
        codeSigningInfo,
        flags,
      });
    } else if (rolloutUpdateGroupWithControlUpdates.length === 0) {
      await this.deleteRolloutAndPublishRollBackToEmbeddedAsync({
        graphqlClient,
        vcsClient,
        exp,
        projectDir,
        projectId,
        rolloutUpdateGroup,
        codeSigningInfo,
        flags,
      });
    } else {
      throw new Error(
        `Some but not all updates in the update group have rollout control updates. This type of group cannot be reverted automatically. Recommendation is to roll out group to 100% and follow up by publishing a new update group over it.`
      );
    }
  }

  private async deleteRolloutAndRepublishControlUpdateGroupAsync({
    graphqlClient,
    exp,
    projectId,
    rolloutUpdateGroupWithControlUpdates,
    codeSigningInfo,
    flags,
  }: {
    graphqlClient: ExpoGraphqlClient;
    exp: ExpoConfig;
    projectId: string;
    rolloutUpdateGroupWithControlUpdates: RolloutUpdateWithControlUpdate[];
    codeSigningInfo: CodeSigningInfo | undefined;
    flags: UpdateRevertUpdateRolloutFlags;
  }): Promise<void> {
    const controlUpdateGroupIds = new Set(
      rolloutUpdateGroupWithControlUpdates.map(update => update.rolloutControlUpdate.group)
    );
    if (controlUpdateGroupIds.size !== 1) {
      throw new Error(
        `The control updates for the update group have differing update groups. This type of update cannot be reverted automatically. Recommendation is to roll out group to 100% and follow up by publishing a new update group over it.`
      );
    }
    const controlUpdateGroupId = Array.from(controlUpdateGroupIds)[0];
    const updateGroupToRepublish = await getUpdateGroupAsync(graphqlClient, controlUpdateGroupId);

    const updateMessage = await getOrAskUpdateMessageAsync(updateGroupToRepublish, flags);
    const targetBranch = {
      branchName: updateGroupToRepublish[0].branchName,
      branchId: updateGroupToRepublish[0].branchId,
    };

    if (!flags.nonInteractive) {
      const confirmMessage = `Are you sure you want to revert the rollout update group with ID "${rolloutUpdateGroupWithControlUpdates[0].groupId}"? This will delete the rollout update group and republish the control update group (ID: "${controlUpdateGroupId})".`;
      const didConfirm = await confirmAsync({ message: confirmMessage });
      if (!didConfirm) {
        throw new Error('Aborting...');
      }
    }

    await this.deleteRolloutUpdateGroupAsync({
      graphqlClient,
      rolloutUpdateGroup: rolloutUpdateGroupWithControlUpdates,
    });

    await republishAsync({
      graphqlClient,
      app: { exp, projectId },
      updatesToPublish: updateGroupToRepublish,
      targetBranch,
      updateMessage,
      codeSigningInfo,
      json: flags.json,
    });
  }

  private async deleteRolloutAndPublishRollBackToEmbeddedAsync({
    graphqlClient,
    vcsClient,
    exp,
    projectDir,
    projectId,
    rolloutUpdateGroup,
    codeSigningInfo,
    flags,
  }: {
    graphqlClient: ExpoGraphqlClient;
    vcsClient: Client;
    exp: ExpoConfig;
    projectDir: string;
    projectId: string;
    rolloutUpdateGroup: RolloutUpdate[];
    codeSigningInfo: CodeSigningInfo | undefined;
    flags: UpdateRevertUpdateRolloutFlags;
  }): Promise<void> {
    const rolloutUpdateGroupId = rolloutUpdateGroup[0].groupId;

    if (!flags.nonInteractive) {
      const confirmMessage = `Are you sure you want to revert the rollout update group with ID "${rolloutUpdateGroupId}"? This will delete the rollout update group and publish a new roll-back-to-embedded update (no control update to roll back to), whose behavior may not be a true revert depending on the previous state of the branch.`;
      const didConfirm = await confirmAsync({ message: confirmMessage });
      if (!didConfirm) {
        throw new Error('Aborting...');
      }
    }

    // check that the expo-updates package version supports roll back to embedded
    await enforceRollBackToEmbeddedUpdateSupportAsync(projectDir);
    const updateMessage = await getUpdateMessageForCommandAsync(vcsClient, {
      updateMessageArg: flags.updateMessage,
      autoFlag: false,
      nonInteractive: flags.nonInteractive,
      jsonFlag: flags.json,
    });

    await this.deleteRolloutUpdateGroupAsync({
      graphqlClient,
      rolloutUpdateGroup,
    });

    const platforms = rolloutUpdateGroup.map(update => update.platform) as UpdatePublishPlatform[];
    const runtimeVersion = rolloutUpdateGroup[0].runtimeVersion;
    const targetBranch = {
      name: rolloutUpdateGroup[0].branchName,
      id: rolloutUpdateGroup[0].branchId,
    };

    await publishRollBackToEmbeddedUpdateAsync({
      graphqlClient,
      projectId,
      exp,
      updateMessage,
      branch: targetBranch,
      codeSigningInfo,
      platforms,
      runtimeVersion,
      json: flags.json,
    });
  }

  private async deleteRolloutUpdateGroupAsync({
    graphqlClient,
    rolloutUpdateGroup,
  }: {
    graphqlClient: ExpoGraphqlClient;
    rolloutUpdateGroup: RolloutUpdate[];
  }): Promise<void> {
    const rolloutUpdateGroupId = rolloutUpdateGroup[0].groupId;

    const updateGroupDeletionReceipt = await scheduleUpdateGroupDeletionAsync(graphqlClient, {
      group: rolloutUpdateGroupId,
    });
    const successfulReceipt = await pollForBackgroundJobReceiptAsync(
      graphqlClient,
      updateGroupDeletionReceipt
    );
    Log.debug('Rollout update group deletion result', { successfulReceipt });
  }

  private sanitizeFlags(
    rawFlags: UpdateRevertUpdateRolloutRawFlags
  ): UpdateRevertUpdateRolloutFlags {
    const branchName = rawFlags.branch;
    const channelName = rawFlags.channel;
    const groupId = rawFlags.group;
    const nonInteractive = rawFlags['non-interactive'];
    const privateKeyPath = rawFlags['private-key-path'];

    if (nonInteractive && !groupId) {
      throw new Error('Only --group can be used in non-interactive mode');
    }

    return {
      branchName,
      channelName,
      groupId,

      updateMessage: rawFlags.message,
      privateKeyPath,
      json: rawFlags.json ?? false,
      nonInteractive,
    };
  }
}

function updateGroupIsRolloutUpdate(updateGroup: UpdateToRepublish): updateGroup is RolloutUpdate {
  return updateGroup.rolloutPercentage !== undefined && updateGroup.rolloutPercentage !== null;
}

function updateGroupIsUpdateGroupWithControlUpdate(
  updateGroup: RolloutUpdate
): updateGroup is RolloutUpdateWithControlUpdate {
  return !!updateGroup.rolloutControlUpdate;
}
