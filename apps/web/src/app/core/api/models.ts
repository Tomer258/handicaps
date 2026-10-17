// Frontend contract types mirroring the API DTOs (apps/api). 64-bit cursors/sequences are decimal strings.

export interface Profile {
  id: string;
  login: string;
  displayName: string;
  avatarHue: number;
  avatarAssetId: string | null;
  createdAt: string;
}

export interface ServerSummary {
  id: string;
  name: string;
  isOwner: boolean;
}

export interface MeResponse {
  user: Profile;
  servers: ServerSummary[];
  sessionId: string;
}

export type ChannelType = 'text' | 'voice';

export interface Channel {
  id: string;
  serverId: string;
  type: ChannelType;
  name: string;
  topic: string | null;
  position: number;
  permissions: number;
  lastMessageSequence: string;
}

export interface Role {
  id: string;
  name: string;
  permissions: number;
  isDefault: boolean;
  position: number;
  color: string | null;
  hoist: boolean;
}

export interface ServerDetail {
  id: string;
  name: string;
  ownerUserId: string | null;
  myPermissions: number;
  policyVersion: string;
  channels: Channel[];
  roles: Role[];
}

export interface Member {
  userId: string;
  login: string;
  displayName: string;
  avatarHue: number;
  avatarAssetId: string | null;
  roleIds: string[];
  isOwner: boolean;
  joinedAt: string;
}

export interface InvitePreview {
  valid: boolean;
  serverName: string | null;
  ownerBootstrap: boolean;
}

export interface Invitation {
  id: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  note: string | null;
}

export interface CreatedInvitation {
  invitation: Invitation;
  secret: string;
  url: string;
}

export interface SessionInfo {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
  persistent: boolean;
}

export interface UserSettings {
  preferredStatus: 'online' | 'idle' | 'doNotDisturb' | 'invisible';
  notifications: Record<string, unknown>;
  audio: Record<string, unknown>;
  appearance: Record<string, unknown>;
  version: string;
}

/** Permission bits — must match Hangar.Core.Permissions.Permission. */
export const Perm = {
  ViewChannel: 1 << 0,
  SendMessages: 1 << 1,
  ManageMessages: 1 << 2,
  AttachFiles: 1 << 3,
  AddReactions: 1 << 4,
  MentionEveryone: 1 << 5,
  JoinVoice: 1 << 6,
  Speak: 1 << 7,
  PublishCamera: 1 << 8,
  ShareScreen: 1 << 9,
  PlaySoundboard: 1 << 10,
  UploadSoundboard: 1 << 11,
  ManageOwnSounds: 1 << 12,
  ManageAnySounds: 1 << 13,
  StopOthersSounds: 1 << 14,
  MuteMembers: 1 << 15,
  RemoveFromVoice: 1 << 16,
  ManageChannels: 1 << 17,
  ManageRoles: 1 << 18,
  ManageInvites: 1 << 19,
  ViewAudit: 1 << 20,
  Administrator: 1 << 21,
} as const;

export function has(mask: number, bit: number): boolean {
  return (mask & bit) === bit;
}
