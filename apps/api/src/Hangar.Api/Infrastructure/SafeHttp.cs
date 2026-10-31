using System.Net;
using System.Net.Sockets;

namespace Hangar.Api.Infrastructure;

/// <summary>
/// Outbound HTTP to user-supplied URLs (link previews). The API runs on the host network next to PostgreSQL,
/// LiveKit, the publisher and the cloud metadata endpoint, so every connection — including each redirect hop — is
/// checked at connect time against the resolved address: public unicast only, ports 80/443, no proxy. Connecting to
/// the address that was checked (not resolving again) also defeats DNS rebinding.
/// </summary>
public static class SafeHttp
{
    public static SocketsHttpHandler CreateHandler(bool allowPrivate = false) => new()
    {
        UseProxy = false,
        AllowAutoRedirect = true,
        MaxAutomaticRedirections = 4,
        AutomaticDecompression = DecompressionMethods.All,
        ConnectTimeout = TimeSpan.FromSeconds(4),
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
        MaxResponseHeadersLength = 64, // KB
        UseCookies = false,
        ConnectCallback = async (ctx, ct) =>
        {
            var port = ctx.DnsEndPoint.Port;
            if (!allowPrivate && port is not (80 or 443)) throw new HttpRequestException($"Port {port} is not allowed.");
            var addresses = IPAddress.TryParse(ctx.DnsEndPoint.Host, out var literal)
                ? [literal]
                : await Dns.GetHostAddressesAsync(ctx.DnsEndPoint.Host, ct);
            var allowed = addresses.Where(a => allowPrivate || IsPublic(a)).ToArray();
            if (allowed.Length == 0) throw new HttpRequestException("That address is not reachable from here.");
            Exception? last = null;
            foreach (var address in allowed)
            {
                var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(new IPEndPoint(address, port), ct);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch (Exception e) when (e is SocketException or OperationCanceledException)
                {
                    socket.Dispose();
                    last = e;
                    if (e is OperationCanceledException) throw;
                }
            }
            throw new HttpRequestException("Could not connect.", last);
        },
    };

    /// <summary>Globally routable unicast only: no loopback, private, link-local, CGNAT, multicast, documentation or reserved ranges.</summary>
    public static bool IsPublic(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return !(b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224 // this network, private, loopback, multicast + reserved
                     || (b[0] == 100 && b[1] >= 64 && b[1] <= 127) // CGNAT
                     || (b[0] == 169 && b[1] == 254) // link-local, cloud metadata
                     || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
                     || (b[0] == 192 && b[1] == 168)
                     || (b[0] == 192 && b[1] == 0 && (b[2] == 0 || b[2] == 2)) // IETF protocol assignments, TEST-NET-1
                     || (b[0] == 192 && b[1] == 88 && b[2] == 99) // 6to4 relay anycast
                     || (b[0] == 198 && (b[1] == 18 || b[1] == 19)) // benchmarking
                     || (b[0] == 198 && b[1] == 51 && b[2] == 100)
                     || (b[0] == 203 && b[1] == 0 && b[2] == 113));
        }
        if (address.AddressFamily != AddressFamily.InterNetworkV6) return false;
        if (address.Equals(IPAddress.IPv6Loopback) || address.Equals(IPAddress.IPv6Any)) return false;
        if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast || address.IsIPv6UniqueLocal) return false;
        var v6 = address.GetAddressBytes();
        // Only global unicast 2000::/3, minus ranges that embed or tunnel to IPv4 or are reserved.
        if ((v6[0] & 0xE0) != 0x20) return false;
        if (v6[0] == 0x20 && v6[1] == 0x01 && v6[2] == 0x00 && v6[3] == 0x00) return false; // Teredo 2001::/32
        if (v6[0] == 0x20 && v6[1] == 0x01 && v6[2] == 0x0d && v6[3] == 0xb8) return false; // documentation
        if (v6[0] == 0x20 && v6[1] == 0x02) return IsPublic(new IPAddress(v6[2..6])); // 6to4 embeds an IPv4 address
        return true;
    }
}
