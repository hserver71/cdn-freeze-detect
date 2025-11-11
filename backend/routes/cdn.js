const express = require('express');

module.exports = (cdnController) => {
  const router = express.Router();

  router.get('/servers', (req, res) => cdnController.getServers(req, res));
  router.post('/servers', (req, res) => cdnController.createServer(req, res));
  router.put('/servers/:id', (req, res) => cdnController.updateServer(req, res));
  router.delete('/servers/:id', (req, res) => cdnController.deleteServer(req, res));

  router.get('/domains', (req, res) => cdnController.getDomainsByQuery(req, res));
  router.get('/servers/:serverId/domains', (req, res) => cdnController.getDomains(req, res));
  router.post('/servers/:serverId/domains', (req, res) => cdnController.createDomain(req, res));
  router.put('/domains/:id', (req, res) => cdnController.updateDomain(req, res));
  router.delete('/domains/:id', (req, res) => cdnController.deleteDomain(req, res));

  return router;
};

