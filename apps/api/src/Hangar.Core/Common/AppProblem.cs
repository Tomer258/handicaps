namespace Hangar.Core.Common;

/// <summary>
/// A failure that maps to an RFC 7807 ProblemDetails response with a stable machine-readable code.
/// Thrown by application services; translated once by the API host.
/// </summary>
public sealed class AppProblem : Exception
{
    public int Status { get; }
    public string Code { get; }
    public IReadOnlyDictionary<string, object?>? Extensions { get; }

    public AppProblem(int status, string code, string message, IReadOnlyDictionary<string, object?>? extensions = null)
        : base(message)
    {
        Status = status;
        Code = code;
        Extensions = extensions;
    }

    public static AppProblem BadRequest(string code, string message) => new(400, code, message);
    public static AppProblem Unauthorized(string code = "auth.required", string message = "Authentication required.") => new(401, code, message);
    public static AppProblem Forbidden(string code = "access.denied", string message = "You do not have permission to do that.") => new(403, code, message);
    public static AppProblem NotFound(string code = "not_found", string message = "Not found.") => new(404, code, message);
    public static AppProblem Conflict(string code, string message) => new(409, code, message);
    public static AppProblem PreconditionFailed(string code, string message) => new(412, code, message);
    public static AppProblem TooLarge(string code, string message) => new(413, code, message);
    public static AppProblem Unprocessable(string code, string message) => new(422, code, message);

    public static AppProblem TooMany(string code, string message, TimeSpan retryAfter) =>
        new(429, code, message, new Dictionary<string, object?> { ["retryAfterMs"] = (long)retryAfter.TotalMilliseconds });
}
