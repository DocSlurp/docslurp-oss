import { lookup as dnsLookup } from "node:dns/promises";
export function isTailnetAddress(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (/^fd7a:115c:a1e0:/i.test(ip)) return true;
  return octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}
/** Private-only is a transport constraint, not proof of operator trust or tenant privacy. */
export async function capacityEndpoint(template: string, name: string, privateOnly: boolean,
  lookup: (host: string) => Promise<string[]> = async host => (await dnsLookup(host, { all: true })).map(entry => entry.address)): Promise<string> {
  const url = new URL(template.replaceAll("{{name}}", name));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Remote media requires a credential-free HTTPS endpoint");
  if (privateOnly) {
    if (!url.hostname.endsWith(".ts.net")) throw new Error("Private-only capacity requires a Tailscale HTTPS name");
    const addresses = await lookup(url.hostname);
    if (!addresses.length || addresses.some(ip => !isTailnetAddress(ip))) throw new Error("Tailscale endpoint did not resolve exclusively to tailnet addresses");
  }
  return url.toString();
}
