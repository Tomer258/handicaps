using System.Diagnostics;
using Hangar.Core.Common;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;

namespace Hangar.Api.Infrastructure;

/// <summary>Maps <see cref="AppProblem"/> (and unexpected exceptions) to RFC 7807 with a stable code and request id.</summary>
public sealed class AppProblemHandler(IProblemDetailsService problems, ILogger<AppProblemHandler> log) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext ctx, Exception ex, CancellationToken ct)
    {
        ProblemDetails pd;
        if (ex is AppProblem ap)
        {
            pd = new ProblemDetails { Status = ap.Status, Title = ap.Message };
            pd.Extensions["code"] = ap.Code;
            if (ap.Extensions is not null)
                foreach (var (k, v) in ap.Extensions) pd.Extensions[k] = v;
            if (ap.Status == 429 && ap.Extensions?.TryGetValue("retryAfterMs", out var ms) == true && ms is long l)
                ctx.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(l / 1000.0)).ToString();
        }
        else if (ex is BadHttpRequestException bad)
        {
            pd = new ProblemDetails { Status = bad.StatusCode, Title = "The request could not be read." };
            pd.Extensions["code"] = bad.StatusCode == 413 ? "request.too_large" : "request.invalid";
        }
        else if (Hangar.Core.Files.DiskFull.Is(ex))
        {
            log.LogCritical(ex, "Disk full during {Method} {Path}", ctx.Request.Method, ctx.Request.Path);
            pd = new ProblemDetails { Status = 507, Title = Hangar.Core.Files.DiskFull.Problem().Message };
            pd.Extensions["code"] = "storage.full";
        }
        else if (IsDatabaseUnavailable(ex))
        {
            log.LogWarning(ex, "Database unavailable for {Method} {Path}", ctx.Request.Method, ctx.Request.Path);
            pd = new ProblemDetails { Status = 503, Title = "The server is having trouble right now. Try again in a moment." };
            pd.Extensions["code"] = "service.unavailable";
            ctx.Response.Headers.RetryAfter = "5";
        }
        else if (ex is OperationCanceledException && ctx.RequestAborted.IsCancellationRequested)
        {
            return true;
        }
        else
        {
            log.LogError(ex, "Unhandled exception for {Method} {Path}", ctx.Request.Method, ctx.Request.Path);
            pd = new ProblemDetails { Status = 500, Title = "Something went wrong." };
            pd.Extensions["code"] = "server.error";
        }

        ctx.Response.StatusCode = pd.Status ?? 500;
        return await problems.TryWriteAsync(new ProblemDetailsContext { HttpContext = ctx, ProblemDetails = pd, Exception = ex });
    }

    /// <summary>Lost/refused PostgreSQL connections (outage, restart, failover) are transient: 503 rather than 500.</summary>
    private static bool IsDatabaseUnavailable(Exception ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
            if (e is Npgsql.NpgsqlException { IsTransient: true } or System.Net.Sockets.SocketException) return true;
        return false;
    }
}

public static class ProblemSetup
{
    public static IServiceCollection AddHangarProblems(this IServiceCollection services)
    {
        services.AddProblemDetails(o => o.CustomizeProblemDetails = c =>
        {
            c.ProblemDetails.Extensions["requestId"] = Activity.Current?.Id ?? c.HttpContext.TraceIdentifier;
            c.ProblemDetails.Extensions.TryAdd("code", c.ProblemDetails.Status switch
            {
                401 => "auth.required",
                403 => "access.denied",
                404 => "not_found",
                429 => "rate_limited",
                _ => "error",
            });
        });
        services.AddExceptionHandler<AppProblemHandler>();
        return services;
    }
}
