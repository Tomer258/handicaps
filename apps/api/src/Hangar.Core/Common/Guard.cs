namespace Hangar.Core.Common;

/// <summary>Boundary validation helpers. Every list and string from a client is bounded.</summary>
public static class Guard
{
    public static string Text(string? value, string field, int min, int max)
    {
        var v = (value ?? string.Empty).Trim();
        if (v.Length < min || v.Length > max)
            throw AppProblem.BadRequest($"validation.{field}", $"{field} must be between {min} and {max} characters.");
        return v;
    }

    public static string? OptionalText(string? value, string field, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var v = value.Trim();
        if (v.Length > max)
            throw AppProblem.BadRequest($"validation.{field}", $"{field} must be at most {max} characters.");
        return v;
    }

    public static int Limit(int? value, int @default, int max) =>
        value is null or <= 0 ? @default : Math.Min(value.Value, max);

    /// <summary>64-bit cursors travel as decimal strings to avoid JavaScript precision loss.</summary>
    public static long? Cursor(string? value, string field)
    {
        if (string.IsNullOrEmpty(value)) return null;
        if (!long.TryParse(value, out var n) || n < 0)
            throw AppProblem.BadRequest($"validation.{field}", $"{field} must be a non-negative integer string.");
        return n;
    }
}
