"""Convert APNIC Bangladesh allocations into an Nginx geo include."""
from ipaddress import IPv4Address, collapse_addresses, ip_network, summarize_address_range
import sys

ipv4 = []
ipv6 = []
for line in sys.stdin:
    fields = line.strip().split("|")
    if len(fields) < 7 or fields[:2] != ["apnic", "BD"] or fields[6] not in {"allocated", "assigned"}:
        continue
    kind, start, amount = fields[2:5]
    if kind == "ipv4":
        first = IPv4Address(start)
        ipv4.extend(summarize_address_range(first, first + (int(amount) - 1)))
    if kind == "ipv6":
        ipv6.append(ip_network(f"{start}/{int(amount)}"))

if len(ipv4) < 50 or len(ipv6) < 10:
    raise SystemExit("The APNIC Bangladesh prefix list was incomplete.")

print("# Data source: https://ftp.apnic.net/stats/apnic/delegated-apnic-latest")
for network in [*collapse_addresses(ipv4), *collapse_addresses(ipv6)]:
    print(f"{network} BD;")
