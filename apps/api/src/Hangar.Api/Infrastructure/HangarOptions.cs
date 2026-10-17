namespace Hangar.Api.Infrastructure;

public sealed class HangarOptions
{
    public string PublicBaseUrl { get; set; } = "http://localhost:4200";
    public string[] AllowedOrigins { get; set; } = [];
    /// <summary>Production: true → Secure cookies with the __Host- prefix. Dev over plain http: false.</summary>
    public bool SecureCookies { get; set; } = true;
    /// <summary>Root for Data Protection keys and private file storage. Relative paths resolve from the content root.</summary>
    public string DataDirectory { get; set; } = "data";

    public string CookieName => SecureCookies ? "__Host-hangar" : "hangar.sid";
    public string AntiforgeryCookieName => SecureCookies ? "__Host-hangar.af" : "hangar.af";
    /// <summary>Readable by Angular (not HttpOnly); carries the request token echoed in X-XSRF-TOKEN.</summary>
    public const string XsrfCookieName = "XSRF-TOKEN";
    public const string XsrfHeaderName = "X-XSRF-TOKEN";
}
