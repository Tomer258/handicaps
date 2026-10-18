using System.Security.Claims;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Mvc;

namespace Hangar.Api.Infrastructure;

/// <summary>Token bucket: up to <see cref="Burst"/> at once, refilled at <see cref="PerMinute"/>.</summary>
public sealed class RateBucket
{
    public int Burst { get; set; }
    public int PerMinute { get; set; }
}

/// <summary>Per-user abuse limits (Hangar:RateLimits). Soundboard plays have their own durable limits in PostgreSQL.</summary>
public sealed class RateLimitOptions
{
    public bool Enabled { get; set; } = true;
    /// <summary>Every /api/v1 request, reads included.</summary>
    public RateBucket All { get; set; } = new() { Burst = 300, PerMinute = 600 };
    public RateBucket Messages { get; set; } = new() { Burst = 15, PerMinute = 40 };
    public RateBucket Uploads { get; set; } = new() { Burst = 6, PerMinute = 12 };
    public RateBucket Voice { get; set; } = new() { Burst = 12, PerMinute = 30 };
    /// <summary>Other state changes (admin, settings, profile, favorites…).</summary>
    public RateBucket Writes { get; set; } = new() { Burst = 30, PerMinute = 60 };
    /// <summary>Hub invocations per connection (typing, heartbeats, subscriptions, voice state).</summary>
    public RateBucket Hub { get; set; } = new() { Burst = 30, PerMinute = 240 };
}

/// <summary>Lock-protected token bucket without timers, for per-connection hub budgets.</summary>
public sealed class TokenBucket(RateBucket b)
{
    private readonly int _burst = Math.Max(1, b.Burst);
    private readonly double _perSecond = Math.Max(1, b.PerMinute) / 60.0;
    private readonly Lock _lock = new();
    private double _tokens = Math.Max(1, b.Burst);
    private long _last = System.Diagnostics.Stopwatch.GetTimestamp();

    public bool TryTake()
    {
        lock (_lock)
        {
            var now = System.Diagnostics.Stopwatch.GetTimestamp();
            _tokens = Math.Min(_burst, _tokens + System.Diagnostics.Stopwatch.GetElapsedTime(_last, now).TotalSeconds * _perSecond);
            _last = now;
            if (_tokens < 1) return false;
            _tokens -= 1;
            return true;
        }
    }
}

public static class RateLimits
{
    public static TokenBucketRateLimiterOptions Options(RateBucket b) => new()
    {
        TokenLimit = Math.Max(1, b.Burst),
        TokensPerPeriod = 1,
        ReplenishmentPeriod = TimeSpan.FromMilliseconds(60_000.0 / Math.Max(1, b.PerMinute)),
        QueueLimit = 0,
        AutoReplenishment = true,
    };

    /// <summary>Which bucket a request draws from besides <see cref="RateLimitOptions.All"/>; null = only the global one.</summary>
    public static string? Category(HttpRequest r)
    {
        var path = r.Path.Value ?? "";
        if (!path.StartsWith("/api/v1/", StringComparison.Ordinal) || HttpMethods.IsGet(r.Method) || HttpMethods.IsHead(r.Method)) return null;
        if (path.StartsWith("/api/v1/auth/", StringComparison.Ordinal)) return null; // own per-IP and per-account throttles
        if (path.EndsWith("/read-position", StringComparison.Ordinal) || path.Contains("/sound-plays") || path.EndsWith("/sound-stop-all", StringComparison.Ordinal))
            return null; // frequent by design / durable limits elsewhere
        if (HttpMethods.IsPost(r.Method) && (path.EndsWith("/attachments", StringComparison.Ordinal) || path.EndsWith("/avatar", StringComparison.Ordinal) ||
            path.EndsWith("/sounds", StringComparison.Ordinal)))
            return "uploads";
        if (path.StartsWith("/api/v1/messages/", StringComparison.Ordinal) || (HttpMethods.IsPost(r.Method) && path.EndsWith("/messages", StringComparison.Ordinal)))
            return "messages";
        if (path.Contains("/voice", StringComparison.Ordinal)) return "voice";
        return "writes";
    }

    private static string Who(HttpContext http) =>
        http.User.FindFirstValue(HangarClaims.UserId) is { } uid ? "u:" + uid : "ip:" + (http.Connection.RemoteIpAddress?.ToString() ?? "unknown");

    public static void AddHangarRateLimits(this IServiceCollection services, IConfiguration config)
    {
        var o = config.GetSection("Hangar:RateLimits").Get<RateLimitOptions>() ?? new RateLimitOptions();
        services.AddSingleton(o);
        services.AddRateLimiter(r =>
        {
            r.RejectionStatusCode = 429;
            r.AddPolicy("auth", http => RateLimitPartition.GetFixedWindowLimiter(
                http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = config.GetValue("Hangar:AuthRequestsPerMinute", 20), Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));

            if (o.Enabled)
            {
                var all = PartitionedRateLimiter.Create<HttpContext, string>(http =>
                    http.Request.Path.StartsWithSegments("/api/v1")
                        ? RateLimitPartition.GetTokenBucketLimiter(Who(http), _ => Options(o.All))
                        : RateLimitPartition.GetNoLimiter(""));
                var byCategory = PartitionedRateLimiter.Create<HttpContext, string>(http =>
                {
                    var cat = Category(http.Request);
                    if (cat is null) return RateLimitPartition.GetNoLimiter("");
                    var bucket = cat switch { "uploads" => o.Uploads, "messages" => o.Messages, "voice" => o.Voice, _ => o.Writes };
                    return RateLimitPartition.GetTokenBucketLimiter(cat + "|" + Who(http), _ => Options(bucket));
                });
                r.GlobalLimiter = PartitionedRateLimiter.CreateChained(all, byCategory);
            }

            r.OnRejected = async (ctx, ct) =>
            {
                var retry = ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var after) ? after : TimeSpan.FromSeconds(1);
                var seconds = Math.Max(1, (int)Math.Ceiling(retry.TotalSeconds));
                ctx.HttpContext.Response.Headers.RetryAfter = seconds.ToString();
                var pd = new ProblemDetails { Status = 429, Title = "You are doing that too fast. Try again in a moment." };
                pd.Extensions["code"] = "rate_limited";
                pd.Extensions["retryAfterMs"] = seconds * 1000L;
                var problems = ctx.HttpContext.RequestServices.GetRequiredService<IProblemDetailsService>();
                await problems.TryWriteAsync(new ProblemDetailsContext { HttpContext = ctx.HttpContext, ProblemDetails = pd });
            };
        });
    }
}
