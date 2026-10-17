using Hangar.Core.Channels;
using Hangar.Core.Permissions;

namespace Hangar.Tests.Unit;

public class PermissionEvaluatorTests
{
    private static readonly Guid Owner = Guid.NewGuid();
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid DefaultRole = Guid.NewGuid();
    private static readonly Guid ModRole = Guid.NewGuid();

    private static PolicyInput Input(Guid user, bool member = true, bool disabled = false, params RoleGrant[] extra) =>
        new(user, Owner, member, disabled, [new RoleGrant(DefaultRole, PermissionSets.Member, true), .. extra]);

    [Fact]
    public void Removed_member_gets_nothing()
    {
        Assert.Equal(Permission.None, PermissionEvaluator.ServerLevel(Input(User, member: false)));
        Assert.Equal(Permission.None, PermissionEvaluator.ChannelLevel(Input(User, member: false), ChannelType.Text, []));
    }

    [Fact]
    public void Disabled_account_gets_nothing_even_if_owner()
    {
        Assert.Equal(Permission.None, PermissionEvaluator.ServerLevel(Input(Owner, disabled: true)));
    }

    [Fact]
    public void Owner_gets_everything_and_ignores_channel_denies()
    {
        var deny = new ChannelOverride(DefaultRole, null, Permission.None, Permission.ViewChannel);
        Assert.Equal(Permission.All, PermissionEvaluator.ServerLevel(Input(Owner)));
        Assert.True(PermissionEvaluator.ChannelLevel(Input(Owner), ChannelType.Text, [deny]).HasFlag(Permission.ViewChannel));
    }

    [Fact]
    public void Administrator_bit_grants_all()
    {
        var input = Input(User, extra: new RoleGrant(ModRole, Permission.Administrator, false));
        Assert.Equal(Permission.All, PermissionEvaluator.ServerLevel(input));
    }

    [Fact]
    public void Role_deny_wins_over_another_roles_allow()
    {
        var input = Input(User, extra: new RoleGrant(ModRole, Permission.None, false));
        var overrides = new[]
        {
            new ChannelOverride(DefaultRole, null, Permission.None, Permission.SendMessages),
            new ChannelOverride(ModRole, null, Permission.SendMessages, Permission.None),
        };
        var mask = PermissionEvaluator.ChannelLevel(input, ChannelType.Text, overrides);
        Assert.False(mask.HasFlag(Permission.SendMessages));
        Assert.True(mask.HasFlag(Permission.ViewChannel));
    }

    [Fact]
    public void Member_allow_overrides_role_deny()
    {
        var overrides = new[]
        {
            new ChannelOverride(DefaultRole, null, Permission.None, Permission.SendMessages),
            new ChannelOverride(null, User, Permission.SendMessages, Permission.None),
        };
        Assert.True(PermissionEvaluator.ChannelLevel(Input(User), ChannelType.Text, overrides).HasFlag(Permission.SendMessages));
    }

    [Fact]
    public void Member_deny_removes_base_permission()
    {
        var overrides = new[] { new ChannelOverride(null, User, Permission.None, Permission.AddReactions) };
        Assert.False(PermissionEvaluator.ChannelLevel(Input(User), ChannelType.Text, overrides).HasFlag(Permission.AddReactions));
    }

    [Fact]
    public void Without_view_channel_nothing_applies()
    {
        var overrides = new[] { new ChannelOverride(DefaultRole, null, Permission.None, Permission.ViewChannel) };
        Assert.Equal(Permission.None, PermissionEvaluator.ChannelLevel(Input(User), ChannelType.Text, overrides));
    }

    [Fact]
    public void Private_channel_visible_only_to_allowed_role()
    {
        var input = Input(User, extra: new RoleGrant(ModRole, Permission.None, false));
        var overrides = new[]
        {
            new ChannelOverride(DefaultRole, null, Permission.None, Permission.ViewChannel),
            new ChannelOverride(ModRole, null, Permission.ViewChannel, Permission.None),
        };
        // Deny wins across role overrides — a private channel needs a member allow or a role without the deny.
        Assert.Equal(Permission.None, PermissionEvaluator.ChannelLevel(input, ChannelType.Text, overrides));
        var withMemberAllow = overrides.Append(new ChannelOverride(null, User, Permission.ViewChannel, Permission.None)).ToArray();
        Assert.True(PermissionEvaluator.ChannelLevel(input, ChannelType.Text, withMemberAllow).HasFlag(Permission.ViewChannel));
    }

    [Fact]
    public void Channel_type_masks_irrelevant_bits()
    {
        var text = PermissionEvaluator.ChannelLevel(Input(User), ChannelType.Text, []);
        var voice = PermissionEvaluator.ChannelLevel(Input(User), ChannelType.Voice, []);
        Assert.False(text.HasFlag(Permission.JoinVoice));
        Assert.True(text.HasFlag(Permission.SendMessages));
        Assert.True(voice.HasFlag(Permission.JoinVoice));
        Assert.True(voice.HasFlag(Permission.PlaySoundboard));
        Assert.False(voice.HasFlag(Permission.SendMessages));
    }

    [Fact]
    public void Join_voice_is_independent_of_speak()
    {
        var overrides = new[] { new ChannelOverride(DefaultRole, null, Permission.None, Permission.Speak) };
        var mask = PermissionEvaluator.ChannelLevel(Input(User), ChannelType.Voice, overrides);
        Assert.True(mask.HasFlag(Permission.JoinVoice));
        Assert.False(mask.HasFlag(Permission.Speak));
    }
}
