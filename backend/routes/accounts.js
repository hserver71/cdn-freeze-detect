const express = require('express');

module.exports = (accountController) => {
  const router = express.Router();

  router.get('/', accountController.list);
  router.post('/', accountController.create);
  router.put('/:id', accountController.update);
  router.delete('/:id', accountController.remove);
  router.get('/:id/contacts', accountController.contacts);
  router.get('/:id/chats/:contactId/messages', accountController.messages);
  router.post('/:id/chats/:contactId/messages/:messageId/notify', accountController.notifyMessage);

  return router;
};


