namespace Hangar.Core.Media;

/// <summary>LiveKit integration settings (section Hangar:LiveKit). Secrets come from configuration, never from source in prod.</summary>
public sealed class LiveKitOptions
{
    /// <summary>Internal HTTP base for RoomService (Twirp), e.g. http://livekit:7880. Never public.</summary>
    public string ApiUrl { get; set; } = "http://localhost:7880";
    /// <summary>Signaling URL handed to browsers (ws:// in dev, wss://rtc.example behind the admission gate in prod).</summary>
    public string PublicUrl { get; set; } = "ws://localhost:7880";
    public string ApiKey { get; set; } = "";
    public string ApiSecret { get; set; } = "";
    /// <summary>Installation-wide human limit across all voice rooms.</summary>
    public int MaxHumans { get; set; } = 15;
    /// <summary>Room capacity: humans plus the soundboard publisher.</summary>
    public int RoomSlots { get; set; } = 16;
    /// <summary>Join tokens are short: they only need to survive until the signaling connection is admitted.</summary>
    public TimeSpan JoinTokenLifetime { get; set; } = TimeSpan.FromMinutes(2);
    /// <summary>A lease not confirmed in its room for this long (never connected, or dropped) ends.</summary>
    public TimeSpan ReconnectGrace { get; set; } = TimeSpan.FromSeconds(45);
    public TimeSpan ReconcileInterval { get; set; } = TimeSpan.FromSeconds(15);
    /// <summary>Installation-wide concurrent screen shares (UI supports up to four stream tiles).</summary>
    public int MaxScreens { get; set; } = 4;
    /// <summary>Installation-wide concurrent cameras (capacity scenario C).</summary>
    public int MaxCameras { get; set; } = 6;
    /// <summary>A reservation must be backed by a published track within this window, and is renewed while it is.</summary>
    public TimeSpan PublishWindow { get; set; } = TimeSpan.FromSeconds(60);
    /// <summary>
    /// Load testing only (runbooks/load-test.md): rooms whose name starts with this prefix are left alone by the
    /// reconciler, so simulated `lk load-test` participants are not evicted. Empty (the default) = no exemption.
    /// </summary>
    public string LoadTestRoomPrefix { get; set; } = "";
}
