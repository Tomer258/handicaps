using Hangar.Api.Infrastructure;
using Hangar.Core.Identity;
using Microsoft.AspNetCore.SignalR;

namespace Hangar.Api.Realtime;

/// <summary>
/// Hub connection authentication alone is insufficient: every invocation re-validates the session row,
/// so a revoked session cannot keep subscribing or typing on an already-open socket.
/// </summary>
public sealed class SessionHubFilter(ConnectionRegistry registry) : IHubFilter
{
    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext ctx, Func<HubInvocationContext, ValueTask<object?>> next)
    {
        var user = ctx.Context.User;
        var info = registry.Get(ctx.Context.ConnectionId);
        var auth = ctx.ServiceProvider.GetRequiredService<AuthService>();
        if (user is null || info is null || info.Revoked ||
            !await auth.ValidateSessionAsync(user.SessionId(), user.UserId(), ctx.Context.ConnectionAborted))
        {
            if (info is not null) info.Revoked = true;
            ctx.Context.Abort();
            throw new HubException("Session expired.");
        }
        return await next(ctx);
    }
}
