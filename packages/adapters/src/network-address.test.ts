import dns from "node:dns";
import { describe, expect, it } from "vitest";
import {
  isCloudMetadataAddress,
  isLinkLocalAddress,
  isPrivateAddress,
  parseLegacyIpv4,
  withPinnedDnsLookup,
} from "./network-address.js";

describe("network address classification", () => {
  it.each([
    "169.254.1.1",
    "fe80::1",
    "::169.254.1.1",
    "::ffff:169.254.1.1",
    "::a9fe:101",
    "::ffff:a9fe:101",
  ])("classifies %s as link-local", (address) => {
    expect(isLinkLocalAddress(address)).toBe(true);
  });

  it.each(["127.0.0.1", "192.168.1.1", "::1", "fd00::1", "203.0.113.1"])(
    "does not classify %s as link-local",
    (address) => {
      expect(isLinkLocalAddress(address)).toBe(false);
    },
  );

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.9",
    "169.254.169.254",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "64:ff9b::10.1.2.3",
    "2002:a9fe:a9fe::1",
    "2002:0a01:0203::",
    "2002:c0a8:0001::1",
  ])("classifies %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "64:ff9b::808:808",
    "64:ff9b::8.8.8.8",
    "2002:808:808::1",
    "::ffff:8.8.8.8",
  ])("classifies %s as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each([
    // IANA special-purpose IPv4 registry, first and last address of each range
    "0.0.0.0",
    "0.255.255.255",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "127.255.255.255",
    "168.63.129.16",
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.0",
    "192.0.0.192",
    "192.0.0.255",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.255.255",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.200",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    // IANA special-purpose IPv6 registry
    "::",
    "::ffff:0:0:0",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "::7f00:1",
    "64:ff9b:1::1",
    "64:ff9b:1:ffff::1",
    "100::",
    "100::1",
    "2001::",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:2::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "5f00::1",
    "fec0::1",
    "ff02::1",
  ])("blocks the special-purpose address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
    expect(isPrivateAddress(`[${address}]`)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.0.1.1",
    "192.169.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "223.255.255.255",
    "2001:4860:4860::8888",
    "2606:4700::6810:84e5",
    "2a00:1450:4007:80f::200e",
    "100:1::1",
  ])("keeps %s reachable", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("fails closed on an unparsable address", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("0177.0.0.1")).toBe(true);
    expect(isPrivateAddress("2130706433")).toBe(true);
  });

  it.each([
    "169.254.169.254",
    "100.100.100.200",
    "fd00:ec2::254",
    "fd00:0ec2:0000:0000:0000:0000:0000:0254",
    "::ffff:100.100.100.200",
    "64:ff9b::6464:64c8",
    "2002:6464:64c8::1",
  ])("classifies %s as a cloud metadata address", (address) => {
    expect(isCloudMetadataAddress(address)).toBe(true);
  });

  it.each(["10.0.0.1", "100.100.100.201", "fd00:ec2::255"])(
    "does not classify %s as a cloud metadata address",
    (address) => {
      expect(isCloudMetadataAddress(address)).toBe(false);
    },
  );
});

describe("pinned dns lookup", () => {
  it("returns the validated address for the pinned hostname", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "8.8.8.8", family: 4 }],
      async () => {
        const result = await new Promise<{ address: string; family?: number }>(
          (resolve, reject) => {
            dns.lookup("connectors.example.test", (error, address, family) => {
              if (error) reject(error);
              else resolve({ address: String(address), family });
            });
          },
        );
        expect(result).toEqual({ address: "8.8.8.8", family: 4 });
      },
    );
  });

  it("does not pin lookups for other hostnames", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "8.8.8.8", family: 4 }],
      async () => {
        const result = await new Promise<string>((resolve, reject) => {
          dns.lookup("127.0.0.1", (error, address) => {
            if (error) reject(error);
            else resolve(String(address));
          });
        });
        expect(result).toBe("127.0.0.1");
      },
    );
  });

  it("pins dns.promises.lookup for the same hostname", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "8.8.8.8", family: 4 }],
      async () => {
        await expect(dns.promises.lookup("connectors.example.test")).resolves.toEqual({
          address: "8.8.8.8",
          family: 4,
        });
      },
    );
  });

  it("filters all-results lookups to the requested family", async () => {
    const dualStack = [
      { address: "8.8.8.8", family: 4 as const },
      { address: "2606:4700:4700::1111", family: 6 as const },
    ];
    await withPinnedDnsLookup("connectors.example.test", dualStack, async () => {
      const result = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
        dns.lookup("connectors.example.test", { all: true, family: 4 }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses as dns.LookupAddress[]);
        });
      });
      expect(result).toEqual([{ address: "8.8.8.8", family: 4 }]);
      await expect(
        dns.promises.lookup("connectors.example.test", { all: true, family: 6 }),
      ).resolves.toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    });
  });

  it("fails a family-filtered lookup when no matching address is pinned", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "8.8.8.8", family: 4 }],
      async () => {
        await expect(
          new Promise((resolve, reject) => {
            dns.lookup("connectors.example.test", { all: true, family: 6 }, (error, addresses) => {
              if (error) reject(error);
              else resolve(addresses);
            });
          }),
        ).rejects.toThrow("Endpoint did not resolve to an address");
      },
    );
  });
});

describe("legacy IPv4 host forms", () => {
  it.each([
    ["2130706433", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["0x7f.1", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
    ["017700000001", "127.0.0.1"],
    ["0xa9.0xfe.0xa9.0xfe", "169.254.169.254"],
    ["3232235777", "192.168.1.1"],
    ["8.8.8.8", "8.8.8.8"],
  ])("reads %s as %s", (host, expected) => {
    expect(parseLegacyIpv4(host)).toBe(expected);
  });

  it.each(["256.1.1.1", "1.2.3.4.5", "08.1.1.1", "example.test", "1..2", "4294967296"])(
    "does not read %s as an address",
    (host) => {
      expect(parseLegacyIpv4(host)).toBeUndefined();
    },
  );
});
