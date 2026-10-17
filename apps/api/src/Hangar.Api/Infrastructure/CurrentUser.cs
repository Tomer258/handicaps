using System.Security.Claims;
using Hangar.Core.Common;

namespace Hangar.Api.Infrastructure;

public static class HangarClaims
{
    public const string UserId = "uid";
    public const string SessionId = "sid";
}

public static class CurrentUserExtensions
{
    public static Guid UserId(this ClaimsPrincipal p) =>
        Guid.TryParse(p.FindFirstValue(HangarClaims.UserId), out var id) ? id : throw AppProblem.Unauthorized();

    public static Guid SessionId(this ClaimsPrincipal p) =>
        Guid.TryParse(p.FindFirstValue(HangarClaims.SessionId), out var id) ? id : throw AppProblem.Unauthorized();

    public static ClaimsPrincipal BuildPrincipal(Guid userId, Guid sessionId, string scheme) =>
        new(new ClaimsIdentity(
        [
            new Claim(HangarClaims.UserId, userId.ToString()),
            new Claim(HangarClaims.SessionId, sessionId.ToString()),
        ], scheme, HangarClaims.UserId, null));
}
