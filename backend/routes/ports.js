const express = require('express');

module.exports = (portController) => {
  const router = express.Router();

  router.get('/', portController.listPorts);
  router.post('/', portController.upsertPort);
  router.delete('/:portNumber', portController.deletePort);

  return router;
};


