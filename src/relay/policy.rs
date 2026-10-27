//! Destination policy: which ports, hostnames and resolved addresses a visitor's stream may reach.
use crate::State;
use anyhow::{Result, anyhow, bail};
use ipnet::{Ipv4Net, Ipv6Net};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use wisp_mux::packet::ConnectPacket;

// Evaluated at compile time: an invalid prefix length fails the build, never a request.
const BLOCKED_V4: [Ipv4Net; 15] = [
    Ipv4Net::new_assert(Ipv4Addr::new(0, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(10, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(100, 64, 0, 0), 10),
    Ipv4Net::new_assert(Ipv4Addr::new(127, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(169, 254, 0, 0), 16),
    Ipv4Net::new_assert(Ipv4Addr::new(172, 16, 0, 0), 12),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 0, 0, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 0, 2, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 88, 99, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 168, 0, 0), 16),
    Ipv4Net::new_assert(Ipv4Addr::new(198, 18, 0, 0), 15),
    Ipv4Net::new_assert(Ipv4Addr::new(198, 51, 100, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(203, 0, 113, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(224, 0, 0, 0), 4),
    Ipv4Net::new_assert(Ipv4Addr::new(240, 0, 0, 0), 4),
];
const BLOCKED_V6: [Ipv6Net; 12] = [
    Ipv6Net::new_assert(Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 0), 96),
    Ipv6Net::new_assert(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0, 0), 96),
    Ipv6Net::new_assert(Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0), 96),
    Ipv6Net::new_assert(Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, 0, 0), 48),
    Ipv6Net::new_assert(Ipv6Addr::new(0x100, 0, 0, 0, 0, 0, 0, 0), 64),
    Ipv6Net::new_assert(Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
    Ipv6Net::new_assert(Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32),
    Ipv6Net::new_assert(Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),
    Ipv6Net::new_assert(Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20),
    Ipv6Net::new_assert(Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),
    Ipv6Net::new_assert(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
    Ipv6Net::new_assert(Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),
];

/// Resolves a CONNECT destination to the single address the relay may dial, or fails with
/// `port blocked`, `host blocked`, a DNS error or `address blocked`, checked in that order.
pub(super) async fn resolve(packet: &ConnectPacket, state: &State) -> Result<IpAddr> {
    if !port_allowed(packet.port) {
        bail!("port blocked");
    }
    let host = normalize_host(&packet.host);
    // Reserved fixture destinations never resolve or connect directly. Only the mock proxy sees them.
    if state.cfg.test_mode
        && let Some(ip) = fixture_address(&host)
    {
        return Ok(ip);
    }
    if !host_allowed(&host) {
        bail!("host blocked");
    }
    let addresses = state.resolver.lookup(&host).await?;
    pick_address(&addresses, &state.cfg.upstream_ips).ok_or_else(|| anyhow!("address blocked"))
}

/// Web ports only: 80 and 443.
fn port_allowed(port: u16) -> bool {
    [80, 443].contains(&port)
}

/// Drops trailing root dots and lowercases ASCII, so policy checks see one spelling.
fn normalize_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// Test-mode fixture hostnames and the documentation addresses the mock proxy expects for them.
fn fixture_address(host: &str) -> Option<IpAddr> {
    match host {
        "fixture.test" | "second.test" => Some(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 10))),
        "failed-upstream.test" => Some(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 11))),
        _ => None,
    }
}

/// Hostname or literal address syntax, excluding loopback, link-local, internal and own names.
fn host_allowed(host: &str) -> bool {
    let blocked = host.len() > 253
        || host.is_empty()
        || host
            .bytes()
            .any(|c| !c.is_ascii_alphanumeric() && !b".-:".contains(&c))
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "shifter.io"
        || host.ends_with(".shifter.io");
    !blocked
}

/// Rejects the whole DNS answer when it is empty or any address is non-public or an upstream
/// proxy address (never filtered); otherwise prefers the first IPv4 address.
fn pick_address(addresses: &[IpAddr], upstream: &[IpAddr]) -> Option<IpAddr> {
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|x| !public_ip(*x) || upstream.contains(x))
    {
        return None;
    }
    addresses
        .iter()
        .find(|x| x.is_ipv4())
        .or(addresses.first())
        .copied()
}

/// Only globally routable destinations, including rejecting mapped IPv4 and translation ranges.
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => !BLOCKED_V4.iter().any(|net| net.contains(&v)),
        IpAddr::V6(v) => {
            (v.segments()[0] & 0xe000) == 0x2000 && !BLOCKED_V6.iter().any(|net| net.contains(&v))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const V4: [&str; 15] = [
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    ];
    const V6: [&str; 12] = [
        "::/96",
        "::ffff:0:0/96",
        "64:ff9b::/96",
        "64:ff9b:1::/48",
        "100::/64",
        "2001::/23",
        "2001:db8::/32",
        "2002::/16",
        "3fff::/20",
        "fc00::/7",
        "fe80::/10",
        "ff00::/8",
    ];

    /// The string-parsing implementation `public_ip` replaced.
    fn reference(ip: IpAddr) -> bool {
        let blocked: &[&str] = match ip {
            IpAddr::V4(_) => &V4,
            IpAddr::V6(_) => &V6,
        };
        if let IpAddr::V6(v) = ip
            && (v.segments()[0] & 0xe000) != 0x2000
        {
            return false;
        }
        !blocked
            .iter()
            .any(|cidr| cidr.parse::<ipnet::IpNet>().unwrap().contains(&ip))
    }

    fn check_edges(first: IpAddr, last: IpAddr, below: Option<IpAddr>, above: Option<IpAddr>) {
        for ip in [Some(first), Some(last), below, above]
            .into_iter()
            .flatten()
        {
            assert_eq!(public_ip(ip), reference(ip), "{ip}");
        }
    }

    #[test]
    fn constant_tables_match_the_cidr_list() {
        for (cidr, net) in V4.iter().zip(BLOCKED_V4) {
            let parsed: Ipv4Net = cidr.parse().unwrap();
            assert_eq!(parsed, net, "{cidr}");
            let (first, last) = (u32::from(net.network()), u32::from(net.broadcast()));
            let v4 = |n: u32| IpAddr::V4(Ipv4Addr::from(n));
            check_edges(
                v4(first),
                v4(last),
                first.checked_sub(1).map(v4),
                last.checked_add(1).map(v4),
            );
        }
        for (cidr, net) in V6.iter().zip(BLOCKED_V6) {
            let parsed: Ipv6Net = cidr.parse().unwrap();
            assert_eq!(parsed, net, "{cidr}");
            let (first, last) = (u128::from(net.network()), u128::from(net.broadcast()));
            let v6 = |n: u128| IpAddr::V6(Ipv6Addr::from(n));
            check_edges(
                v6(first),
                v6(last),
                first.checked_sub(1).map(v6),
                last.checked_add(1).map(v6),
            );
        }
    }

    #[test]
    fn ports() {
        assert!(port_allowed(80));
        assert!(port_allowed(443));
        for port in [0, 22, 8080, 8443, 65535] {
            assert!(!port_allowed(port), "{port}");
        }
    }

    #[test]
    fn hostnames() {
        assert_eq!(normalize_host("Example.COM."), "example.com");
        let longest = format!("{}.example", "a".repeat(245));
        assert_eq!(longest.len(), 253);
        let too_long = format!("{longest}a");
        for host in [
            "example.com",
            "a-b.example",
            "xn--bcher-kva.example",
            "notshifter.io",
            "mylocal",
            "1.1.1.1",
            "2606:4700::1111",
            longest.as_str(),
        ] {
            assert!(host_allowed(host), "{host}");
        }
        for host in [
            "",
            too_long.as_str(),
            "exa_mple.com",
            "exa mple.com",
            "localhost",
            "a.localhost",
            "printer.local",
            "db.internal",
            "shifter.io",
            "blr.p.shifter.io",
        ] {
            assert!(!host_allowed(host), "{host}");
        }
    }

    #[test]
    fn fixture_mapping() {
        let primary = Some("203.0.113.10".parse::<IpAddr>().unwrap());
        assert_eq!(fixture_address("fixture.test"), primary);
        assert_eq!(fixture_address("second.test"), primary);
        assert_eq!(
            fixture_address("failed-upstream.test"),
            Some("203.0.113.11".parse::<IpAddr>().unwrap())
        );
        assert_eq!(fixture_address("fixture.test.example"), None);
        assert_eq!(fixture_address("example.test"), None);
    }

    #[test]
    fn address_choice() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert_eq!(pick_address(&[], &[]), None);
        assert_eq!(pick_address(&[ip("8.8.8.8")], &[]), Some(ip("8.8.8.8")));
        assert_eq!(
            pick_address(&[ip("2606:4700::1111"), ip("1.1.1.1")], &[]),
            Some(ip("1.1.1.1"))
        );
        assert_eq!(
            pick_address(&[ip("2606:4700::1111")], &[]),
            Some(ip("2606:4700::1111"))
        );
        assert_eq!(pick_address(&[ip("8.8.8.8"), ip("10.0.0.1")], &[]), None);
        assert_eq!(pick_address(&[ip("8.8.8.8")], &[ip("8.8.8.8")]), None);
    }

    #[test]
    fn destination_policy() {
        for s in [
            "127.0.0.1",
            "10.2.3.4",
            "100.64.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "198.18.0.1",
            "203.0.113.1",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "fd00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(s.parse().unwrap()), "{s}");
        }
        for s in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_ip(s.parse().unwrap()), "{s}");
        }
    }
}
