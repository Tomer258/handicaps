import { Perm } from '../../core/api/models';

export interface PermGroup {
  label: string;
  perms: { bit: number; label: string; hint?: string }[];
}

export const PERM_GROUPS: PermGroup[] = [
  { label: 'Text', perms: [
    { bit: Perm.ViewChannel, label: 'View channels' }, { bit: Perm.SendMessages, label: 'Send messages' }, { bit: Perm.AttachFiles, label: 'Attach files' },
    { bit: Perm.AddReactions, label: 'Add reactions' }, { bit: Perm.MentionEveryone, label: 'Mention @everyone' }, { bit: Perm.ManageMessages, label: 'Manage messages' },
  ] },
  { label: 'Voice & video', perms: [
    { bit: Perm.JoinVoice, label: 'Join voice' }, { bit: Perm.Speak, label: 'Speak' }, { bit: Perm.PublishCamera, label: 'Camera' }, { bit: Perm.ShareScreen, label: 'Share screen' },
    { bit: Perm.MuteMembers, label: 'Mute members' }, { bit: Perm.RemoveFromVoice, label: 'Remove from voice' },
  ] },
  { label: 'Soundboard', perms: [
    { bit: Perm.PlaySoundboard, label: 'Play sounds' }, { bit: Perm.UploadSoundboard, label: 'Upload sounds' }, { bit: Perm.ManageOwnSounds, label: 'Manage own sounds' },
    { bit: Perm.ManageAnySounds, label: 'Manage any sound' }, { bit: Perm.StopOthersSounds, label: "Stop others' sounds" },
  ] },
  { label: 'Server', perms: [
    { bit: Perm.ManageChannels, label: 'Manage channels' }, { bit: Perm.ManageRoles, label: 'Manage roles' }, { bit: Perm.ManageInvites, label: 'Manage invites' },
    { bit: Perm.ViewAudit, label: 'View audit log' }, { bit: Perm.Administrator, label: 'Administrator (everything)' },
  ] },
];

/** Bits that only make sense on a channel of that type (overrides editor). */
export const TEXT_BITS = PERM_GROUPS[0].perms.map((p) => p.bit);
export const VOICE_BITS = [...PERM_GROUPS[1].perms, ...PERM_GROUPS[2].perms].map((p) => p.bit);
