namespace Hangar.Core.Permissions;

/// <summary>
/// Permission bits stored in Role.PermissionMask and ChannelPermission allow/deny masks.
/// One evaluator (<see cref="PermissionEvaluator"/>) interprets them; there is no second grant table.
/// </summary>
[Flags]
public enum Permission : long
{
    None = 0,
    ViewChannel = 1L << 0,
    SendMessages = 1L << 1,
    ManageMessages = 1L << 2,
    AttachFiles = 1L << 3,
    AddReactions = 1L << 4,
    MentionEveryone = 1L << 5,
    JoinVoice = 1L << 6,
    Speak = 1L << 7,
    PublishCamera = 1L << 8,
    ShareScreen = 1L << 9,
    PlaySoundboard = 1L << 10,
    UploadSoundboard = 1L << 11,
    ManageOwnSounds = 1L << 12,
    ManageAnySounds = 1L << 13,
    StopOthersSounds = 1L << 14,
    MuteMembers = 1L << 15,
    RemoveFromVoice = 1L << 16,
    ManageChannels = 1L << 17,
    ManageRoles = 1L << 18,
    ManageInvites = 1L << 19,
    ViewAudit = 1L << 20,
    Administrator = 1L << 21,

    All = (1L << 22) - 1,
}

public static class PermissionSets
{
    public const Permission Member =
        Permission.ViewChannel | Permission.SendMessages | Permission.AttachFiles | Permission.AddReactions |
        Permission.JoinVoice | Permission.Speak | Permission.PublishCamera | Permission.ShareScreen |
        Permission.PlaySoundboard | Permission.UploadSoundboard | Permission.ManageOwnSounds;

    public const Permission Moderator =
        Member | Permission.ManageMessages | Permission.MentionEveryone | Permission.StopOthersSounds |
        Permission.MuteMembers | Permission.RemoveFromVoice | Permission.ManageAnySounds;

    public const Permission Admin = Permission.All;

    /// <summary>Bits that only make sense on a channel of a particular type.</summary>
    public const Permission TextOnly = Permission.SendMessages | Permission.AttachFiles | Permission.AddReactions |
                                       Permission.MentionEveryone | Permission.ManageMessages;

    public const Permission VoiceOnly = Permission.JoinVoice | Permission.Speak | Permission.PublishCamera |
                                        Permission.ShareScreen | Permission.PlaySoundboard |
                                        Permission.MuteMembers | Permission.RemoveFromVoice | Permission.StopOthersSounds;
}
