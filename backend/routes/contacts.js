const express = require('express');

module.exports = (contactController) => {
  const router = express.Router();

  router.get('/', contactController.list);
  router.post('/', contactController.create);
  router.put('/:id', contactController.update);
  router.delete('/:id', contactController.delete);
  router.post('/sync', contactController.sync);

  return router;
};

