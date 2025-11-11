const { isIPv4, isIPv6 } = require('net');

class IPUtils {
    // Convert IPv4 to long integer - Handle large numbers properly
    static ip2long(ip) {
        if (!ip || !this.isIPv4(ip)) return null;

        try {
            const parts = ip.split('.');
            // Validate each part is a number between 0-255
            for (let part of parts) {
                const num = parseInt(part, 10);
                if (isNaN(num) || num < 0 || num > 255) {
                    return null;
                }
            }

            // Use BigInt to handle large numbers without overflow
            const result = (parseInt(parts[0]) * 16777216) +
                (parseInt(parts[1]) * 65536) +
                (parseInt(parts[2]) * 256) +
                parseInt(parts[3]);

            return Number(result);
        } catch (error) {
            return null;
        }
    }

    // Convert IPv4 to BigInt to handle very large numbers safely
    static ip2bigint(ip) {
        const numericString = this.ip2numericString(ip);
        return numericString ? BigInt(numericString) : null;
    }

    // Check if IP is IPv4 (direct wrapper)
    static isIPv4(ip) {
        return isIPv4(ip);
    }

    // Check if IP is IPv6
    static isIPv6(ip) {
        return isIPv6(ip);
    }

    // Check if IP is IPv4 or IPv6
    static getIPVersion(ip) {
        if (this.isIPv4(ip)) return 'ipv4';
        if (this.isIPv6(ip)) return 'ipv6';
        return null;
    }

    // Validate IP range (both numeric and string format)
    static isValidIPRange(startIP, endIP) {
        if (!this.isIPv4(startIP) || !this.isIPv4(endIP)) {
            return false;
        }

        const startBigInt = this.ip2bigint(startIP);
        const endBigInt = this.ip2bigint(endIP);

        if (!startBigInt || !endBigInt) {
            return false;
        }

        // Check range order
        if (startBigInt > endBigInt) {
            return false;
        }

        return true;
    }
    static ip2numericString(ip) {
        if (!ip || !this.isIPv4(ip)) return null;

        try {
            const parts = ip.split('.');
            for (let part of parts) {
                const num = parseInt(part, 10);
                if (isNaN(num) || num < 0 || num > 255) {
                    return null;
                }
            }

            // Calculate as BigInt but return as string
            const result = (BigInt(parts[0]) * BigInt(16777216)) +
                (BigInt(parts[1]) * BigInt(65536)) +
                (BigInt(parts[2]) * BigInt(256)) +
                BigInt(parts[3]);

            return result.toString(); // Return as string for MySQL compatibility
        } catch (error) {
            return null;
        }
    }
}

module.exports = IPUtils;