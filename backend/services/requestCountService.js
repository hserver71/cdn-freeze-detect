class RequestCountService {
  constructor() {
    this.databaseService = createDbConnection();
  }
}

module.exports = RequestCountService;