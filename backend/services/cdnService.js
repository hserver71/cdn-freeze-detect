class CdnService {
  constructor(db) {
    this.db = db;
  }

  async getServers() {
    const query = `SELECT id, name, ip_address AS ipAddress, created_at AS createdAt, updated_at AS updatedAt
                   FROM cdn_servers ORDER BY name ASC`;
    const [rows] = await this.db.execute(query);
    return rows;
  }

  async getServerByIp(ipAddress) {
    const query = `SELECT id, name, ip_address AS ipAddress, created_at AS createdAt, updated_at AS updatedAt
                   FROM cdn_servers WHERE ip_address = ? LIMIT 1`;
    const [rows] = await this.db.execute(query, [ipAddress]);
    return rows.length > 0 ? rows[0] : null;
  }

  async createServer({ name, ipAddress }) {
    const query = `INSERT INTO cdn_servers (name, ip_address) VALUES (?, ?)`;
    const [result] = await this.db.execute(query, [name.trim(), ipAddress.trim()]);
    return { id: result.insertId, name, ipAddress };
  }

  async updateServer(id, { name, ipAddress }) {
    const query = `UPDATE cdn_servers SET name = ?, ip_address = ? WHERE id = ?`;
    const [result] = await this.db.execute(query, [name.trim(), ipAddress.trim(), id]);
    return result.affectedRows > 0;
  }

  async deleteServer(id) {
    const query = `DELETE FROM cdn_servers WHERE id = ?`;
    const [result] = await this.db.execute(query, [id]);
    return result.affectedRows > 0;
  }

  async getDomains(serverId) {
    const query = `SELECT id, domain, created_at AS createdAt, updated_at AS updatedAt
                   FROM cdn_server_domains WHERE server_id = ? ORDER BY domain ASC`;
    const [rows] = await this.db.execute(query, [serverId]);
    return rows;
  }

  async createDomain(serverId, domain) {
    const query = `INSERT INTO cdn_server_domains (server_id, domain) VALUES (?, ?)`;
    const [result] = await this.db.execute(query, [serverId, domain.trim()]);
    return { id: result.insertId, serverId, domain };
  }

  async updateDomain(id, domain) {
    const query = `UPDATE cdn_server_domains SET domain = ? WHERE id = ?`;
    const [result] = await this.db.execute(query, [domain.trim(), id]);
    return result.affectedRows > 0;
  }

  async deleteDomain(id) {
    const query = `DELETE FROM cdn_server_domains WHERE id = ?`;
    const [result] = await this.db.execute(query, [id]);
    return result.affectedRows > 0;
  }

  async getDomainsByIp(ipAddress) {
    const server = await this.getServerByIp(ipAddress);
    if (!server) {
      return { server: null, domains: [] };
    }
    const domains = await this.getDomains(server.id);
    return { server, domains };
  }
}

module.exports = CdnService;

