using Hangar.Core.Common;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Options;

namespace Hangar.Api.Infrastructure;

/// <summary>
/// Antiforgery + Origin check for every unsafe /api request (including login and invitation redemption).
/// The auth cookie is SameSite=Lax and HttpOnly; the XSRF request token is readable by Angular and echoed in a header.
/// </summary>
public sealed class CsrfFilter(IAntiforgery antiforgery, IOptions<HangarOptions> options) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (!HttpMethods.IsGet(http.Request.Method) && !HttpMethods.IsHead(http.Request.Method) && !HttpMethods.IsOptions(http.Request.Method))
        {
            OriginGuard.Ensure(http, options.Value);
            try
            {
                await antiforgery.ValidateRequestAsync(http);
            }
            catch (AntiforgeryValidationException)
            {
                throw new AppProblem(400, "csrf.invalid", "Your session token expired. Reload the page and try again.");
            }
        }
        return await next(context);
    }
}

public static class OriginGuard
{
    /// <summary>Rejects credentialed cross-origin requests. Absent Origin (same-origin GET/navigations) is allowed.</summary>
    public static void Ensure(HttpContext http, HangarOptions opt)
    {
        var origin = http.Request.Headers.Origin.ToString();
        if (string.IsNullOrEmpty(origin)) return;
        var self = $"{http.Request.Scheme}://{http.Request.Host}";
        if (string.Equals(origin, self, StringComparison.OrdinalIgnoreCase)) return;
        if (opt.AllowedOrigins.Any(o => string.Equals(o, origin, StringComparison.OrdinalIgnoreCase))) return;
        throw new AppProblem(403, "origin.denied", "Cross-origin request rejected.");
    }
}

public static class XsrfCookie
{
    /// <summary>Issues a fresh request token for the current principal (call after sign-in/out too).</summary>
    public static void Issue(HttpContext http, IAntiforgery antiforgery, HangarOptions opt)
    {
        var tokens = antiforgery.GetAndStoreTokens(http);
        http.Response.Cookies.Append(HangarOptions.XsrfCookieName, tokens.RequestToken!, new CookieOptions
        {
            HttpOnly = false,
            Secure = opt.SecureCookies,
            SameSite = SameSiteMode.Strict,
            Path = "/",
        });
    }
}
