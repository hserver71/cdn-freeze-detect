class PortService {
  constructor(db) {
    this.db = db;
  }

  async listPorts() {
    const ports = await this.db.listPorts();
    return ports.sort((a, b) => a.portNumber - b.portNumber);
  }

  async getPort(portNumber) {
    return this.db.getPortByNumber(portNumber);
  }

  async upsertPort(portData) {
    await this.db.upsertPort(portData);
    return this.getPort(portData.portNumber);
  }

  async deletePort(portNumber) {
    return this.db.deletePort(portNumber);
  }
}

module.exports = PortService;


