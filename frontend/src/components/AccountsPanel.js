import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './AccountsPanel.css';

const MESSAGE_PAGE_SIZE = 50;

const ROLE_OPTIONS = [
  { value: '', label: '— No role —' },
  { value: 'important', label: 'Important source' },
  { value: 'notify', label: 'Notify target' },
  { value: 'self', label: 'Me' },
  { value: 'boss', label: 'Boss' },
];

const INITIAL_CONTACT_FORM = {
  name: '',
  role: '',
  telegramUsername: '',
  telegramChatId: '',
  firstName: '',
  lastName: '',
  telegramPhone: '',
  notes: '',
};

const AccountsPanel = () => {
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [selectedContactId, setSelectedContactId] = useState(null);
  const [messagesCursor, setMessagesCursor] = useState(null);
  const [error, setError] = useState('');
  const [messagesError, setMessagesError] = useState('');
  const [contactError, setContactError] = useState('');
  const [contactForm, setContactForm] = useState(INITIAL_CONTACT_FORM);
  const [editingContactId, setEditingContactId] = useState(null);
  const [submittingContact, setSubmittingContact] = useState(false);
  const [notifyForwarding, setNotifyForwarding] = useState({
    enabled: false,
    loading: false,
    error: '',
    fetched: false,
  });
  const [contactModalOpen, setContactModalOpen] = useState(false);

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) || null,
    [accounts, selectedAccountId]
  );

  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.id === selectedContactId) || null,
    [contacts, selectedContactId]
  );

  const fetchAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    setError('');
    try {
      const response = await fetch('/api/accounts');
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to load accounts');
      }
      setAccounts(data.accounts || []);
      if ((data.accounts || []).length > 0) {
        setSelectedAccountId((prev) => prev || data.accounts[0].id);
      }
    } catch (err) {
      console.error('❌ Failed to load accounts:', err);
      setError(err.message || 'Failed to load accounts');
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const fetchNotifyForwarding = useCallback(async () => {
    try {
      setNotifyForwarding((prev) => ({ ...prev, loading: true, error: '' }));
      const response = await fetch('/api/settings/notify-forwarding');
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to load notify setting');
      }
      setNotifyForwarding({
        enabled: Boolean(data.enabled),
        loading: false,
        error: '',
        fetched: true,
      });
    } catch (err) {
      console.error('❌ Failed to load notify forwarding setting:', err);
      setNotifyForwarding((prev) => ({
        ...prev,
        loading: false,
        error: err.message || 'Failed to load notify setting',
        fetched: true,
      }));
    }
  }, []);

  useEffect(() => {
    fetchNotifyForwarding();
  }, [fetchNotifyForwarding]);

  const fetchContacts = useCallback(async (accountId) => {
    if (!accountId) {
      setContacts([]);
      return;
    }
    setLoadingContacts(true);
    setError('');
    try {
      const response = await fetch(`/api/accounts/${accountId}/contacts`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to load contacts');
      }
      setContacts(data.contacts || []);
      if ((data.contacts || []).length > 0) {
        setSelectedContactId((prev) => {
          const stillExists = data.contacts.some((contact) => contact.id === prev);
          return stillExists ? prev : data.contacts[0].id;
        });
      } else {
        setSelectedContactId(null);
      }
    } catch (err) {
      console.error('❌ Failed to load contacts:', err);
      setError(err.message || 'Failed to load contacts');
    } finally {
      setLoadingContacts(false);
    }
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      fetchContacts(selectedAccountId);
    } else {
      setContacts([]);
      setSelectedContactId(null);
    }
  }, [selectedAccountId, fetchContacts]);

  const fetchMessages = useCallback(
    async ({ accountId, contactId, beforeId = null }) => {
      if (!accountId || !contactId) {
        setMessages([]);
        setMessagesCursor(null);
        return;
      }
      setLoadingMessages(true);
      setMessagesError('');
      try {
        const params = new URLSearchParams();
        params.append('limit', MESSAGE_PAGE_SIZE.toString());
        if (beforeId) {
          params.append('beforeId', beforeId.toString());
        }
        const response = await fetch(
          `/api/accounts/${accountId}/chats/${contactId}/messages?${params.toString()}`
        );
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to load chat history');
        }
        const newMessages = data.messages || [];
        if (beforeId) {
          setMessages((prev) => [...prev, ...newMessages]);
        } else {
          setMessages(newMessages);
        }
        if (newMessages.length === MESSAGE_PAGE_SIZE) {
          const last = newMessages[newMessages.length - 1];
          setMessagesCursor(last.id);
        } else {
          setMessagesCursor(null);
        }
      } catch (err) {
        console.error('❌ Failed to load messages:', err);
        setMessagesError(err.message || 'Failed to load chat history');
      } finally {
        setLoadingMessages(false);
      }
    },
    []
  );

  useEffect(() => {
    if (selectedAccountId && selectedContactId) {
      fetchMessages({ accountId: selectedAccountId, contactId: selectedContactId });
    } else {
      setMessages([]);
      setMessagesCursor(null);
    }
  }, [selectedAccountId, selectedContactId, fetchMessages]);

  const closeContactModal = ({ resetError = true } = {}) => {
    setContactModalOpen(false);
    setContactForm(INITIAL_CONTACT_FORM);
    setEditingContactId(null);
    setSubmittingContact(false);
    if (resetError) {
      setContactError('');
    }
  };

  const openCreateContactModal = () => {
    if (!selectedAccountId) {
      setContactError('Select an account first.');
      return;
    }
    setEditingContactId(null);
    setContactForm(INITIAL_CONTACT_FORM);
    setContactError('');
    setContactModalOpen(true);
  };

  const handleSelectAccount = (accountId) => {
    if (accountId === selectedAccountId) {
      return;
    }
    setSelectedAccountId(accountId);
    setMessages([]);
    setMessagesCursor(null);
    setContactError('');
    closeContactModal({ resetError: false });
  };

  const handleSelectContact = (contactId) => {
    if (contactId === selectedContactId) {
      return;
    }
    setSelectedContactId(contactId);
    setMessages([]);
    setMessagesCursor(null);
  };

  useEffect(() => {
    closeContactModal({ resetError: false });
  }, [selectedAccountId]);

  const handleContactInputChange = (event) => {
    const { name, value } = event.target;
    setContactForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleEditContact = (contact, event) => {
    if (event) {
      event.stopPropagation();
    }
    setEditingContactId(contact.id);
    setContactForm({
      name: contact.name || '',
      role: contact.role || '',
      telegramUsername: contact.telegramUsername || '',
      telegramChatId: contact.telegramChatId || '',
      firstName: contact.firstName || '',
      lastName: contact.lastName || '',
      telegramPhone: contact.telegramPhone || '',
      notes: contact.notes || '',
    });
    setContactError('');
    setContactModalOpen(true);
  };

  const handleDeleteContact = async (contactId, event) => {
    event?.stopPropagation();
    if (!window.confirm('Delete this contact?')) {
      return;
    }
    try {
      const response = await fetch(`/api/contacts/${contactId}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to delete contact');
      }
      if (editingContactId === contactId) {
        closeContactModal({ resetError: false });
      }
      await fetchContacts(selectedAccountId);
    } catch (err) {
      console.error('❌ Failed to delete contact:', err);
      setContactError(err.message || 'Failed to delete contact');
    }
  };

  const handleContactSubmit = async (event) => {
    event.preventDefault();
    if (!selectedAccountId) {
      setContactError('Select an account first.');
      return;
    }
    if (!contactForm.name.trim()) {
      setContactError('Name is required.');
      return;
    }
    setSubmittingContact(true);
    setContactError('');
    try {
      const payload = {
        ...contactForm,
        accountId: selectedAccountId,
        telegramChatId: contactForm.telegramChatId
          ? Number(contactForm.telegramChatId)
          : null,
      };
      const isEdit = Boolean(editingContactId);
      const response = await fetch(`/api/contacts${isEdit ? `/${editingContactId}` : ''}`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to save contact');
      }
      closeContactModal();
      await fetchContacts(selectedAccountId);
    } catch (err) {
      console.error('❌ Failed to save contact:', err);
      setContactError(err.message || 'Failed to save contact');
    } finally {
      setSubmittingContact(false);
    }
  };

  const handleLoadMore = () => {
    if (!messagesCursor || !selectedAccountId || !selectedContactId) {
      return;
    }
    fetchMessages({
      accountId: selectedAccountId,
      contactId: selectedContactId,
      beforeId: messagesCursor,
    });
  };

  const handleRefreshMessages = () => {
    if (selectedAccountId && selectedContactId) {
      fetchMessages({ accountId: selectedAccountId, contactId: selectedContactId });
    }
  };

  const handleToggleNotifyForwarding = async () => {
    if (!notifyForwarding.fetched || notifyForwarding.loading) {
      return;
    }
    const nextEnabled = !notifyForwarding.enabled;
    setNotifyForwarding((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const response = await fetch('/api/settings/notify-forwarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Notify update failed (${response.status})`);
      }
      setNotifyForwarding({
        enabled: Boolean(data.enabled),
        loading: false,
        error: '',
        fetched: true,
      });
    } catch (err) {
      console.error('❌ Failed to update notify forwarding setting:', err);
      setNotifyForwarding((prev) => ({
        ...prev,
        loading: false,
        error: err.message || 'Failed to update notify setting',
      }));
    }
  };

  const formatDateTime = (value) => {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  };

  return (
    <div className="page-content accounts-layout">
      <header className="accounts-header">
        <div>
          <h1>Accounts</h1>
          <p className="accounts-subtitle">
            Monitor chat history for the personal watcher account and the bot account. Select an account, then choose a contact to inspect the conversation timeline.
          </p>
        </div>
        <div className="accounts-actions">
          <button type="button" onClick={fetchAccounts} disabled={loadingAccounts}>
            {loadingAccounts ? 'Refreshing…' : 'Refresh accounts'}
          </button>
          {selectedAccountId && selectedContactId && (
            <button type="button" onClick={handleRefreshMessages} disabled={loadingMessages}>
              {loadingMessages ? 'Refreshing…' : 'Refresh chat'}
            </button>
          )}
          <button
            type="button"
            className={`notify-toggle ${notifyForwarding.enabled ? 'active' : ''}`}
            onClick={handleToggleNotifyForwarding}
            disabled={notifyForwarding.loading}
            title="Toggle automatic notify forwarding"
          >
            {notifyForwarding.loading
              ? 'Updating…'
              : notifyForwarding.enabled
              ? 'Notify Forwarding: ON'
              : 'Notify Forwarding: OFF'}
          </button>
        </div>
      </header>

      {error && <div className="accounts-banner warning">{error}</div>}
      {notifyForwarding.error && <div className="accounts-banner warning">{notifyForwarding.error}</div>}

      <div className="accounts-columns">
        <section className="accounts-column">
          <h2>Accounts</h2>
          {loadingAccounts ? (
            <div className="accounts-placeholder">Loading accounts…</div>
          ) : accounts.length === 0 ? (
            <div className="accounts-placeholder">No accounts yet.</div>
          ) : (
            <ul className="accounts-list">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className={account.id === selectedAccountId ? 'active' : ''}
                  onClick={() => handleSelectAccount(account.id)}
                >
                  <div className="accounts-list-primary">{account.name}</div>
                  <div className="accounts-list-meta">
                    <span className={`badge ${account.type}`}>{account.type}</span>
                    {account.accountKey && <span className="mono">{account.accountKey}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="accounts-column contacts-column">
          <div className="contacts-header">
            <div>
              <h2>Contacts</h2>
              <div className="contacts-header-meta">
                <span>{contacts.length} total</span>
                {selectedAccount && <span>Account: <strong>{selectedAccount.name}</strong></span>}
              </div>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={openCreateContactModal}
              disabled={submittingContact || !selectedAccountId}
            >
              Add contact
            </button>
          </div>

          {!contactModalOpen && contactError && (
            <div className="accounts-banner warning">{contactError}</div>
          )}

          {loadingContacts ? (
            <div className="accounts-placeholder">Loading contacts…</div>
          ) : contacts.length === 0 ? (
            <div className="accounts-placeholder">
              {selectedAccount ? 'No contacts assigned to this account yet.' : 'Select an account.'}
            </div>
          ) : (
            <ul className="accounts-contacts-list">
              {contacts.map((contact) => (
                <li
                  key={contact.id}
                  className={contact.id === selectedContactId ? 'active' : ''}
                  onClick={() => handleSelectContact(contact.id)}
                >
                  <div className="accounts-list-primary">{contact.name}</div>
                  <div className="accounts-list-meta">
                    {contact.role ? <span className="badge role">{contact.role}</span> : null}
                    {contact.telegramUsername ? `@${contact.telegramUsername}` : '—'}
                    {contact.telegramChatId ? <span className="mono">ID: {contact.telegramChatId}</span> : null}
                  </div>
                  <div className="contact-actions">
                    <button type="button" onClick={(event) => handleEditContact(contact, event)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={(event) => handleDeleteContact(contact.id, event)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

        </section>

        <section className="accounts-column messages-column">
          <div className="messages-header">
            <div>
              <h2>Chat Log</h2>
              <div className="messages-header-meta">
                <span>
                  Account:{' '}
                  {selectedAccount ? (
                    <strong>{selectedAccount.name}</strong>
                  ) : (
                    <em>not selected</em>
                  )}
                </span>
                <span>
                  Contact:{' '}
                  {selectedContact ? (
                    <strong>{selectedContact.name}</strong>
                  ) : (
                    <em>not selected</em>
                  )}
                </span>
              </div>
            </div>
          </div>

          {messagesError && <div className="accounts-banner warning">{messagesError}</div>}

          <div className="messages-body">
            {loadingMessages && messages.length === 0 ? (
              <div className="accounts-placeholder">Loading chat history…</div>
            ) : messages.length === 0 ? (
              <div className="accounts-placeholder">
                {selectedContact
                  ? 'No messages recorded for this contact yet.'
                  : 'Select a contact to view chat history.'}
              </div>
            ) : (
              <div className="messages-list">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`message-item ${message.direction === 'outgoing' ? 'outgoing' : 'incoming'}`}
                  >
                    <div className="message-meta">
                      <span className="direction">{message.direction}</span>
                      <span>{formatDateTime(message.occurredAt || message.createdAt)}</span>
                    </div>
                    <div className="message-text">{message.message || <em>(no text)</em>}</div>
                    <div className="message-meta secondary">
                      {message.senderDisplay || message.senderUsername || 'Unknown sender'}
                    {message.hasMedia ? <span className="message-media-flag"> • media</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="messages-footer">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMessages || !messagesCursor}
            >
              {messagesCursor ? (loadingMessages ? 'Loading…' : 'Load older messages') : 'No more messages'}
            </button>
          </div>
        </section>
      </div>
      {contactModalOpen && (
        <div className="contact-modal-overlay" role="dialog" aria-modal="true">
          <div className="contact-modal">
            <div className="contact-modal-header">
              <div>
                <h3>{editingContactId ? 'Edit contact' : 'Add contact'}</h3>
                {selectedAccount && (
                  <p className="contact-modal-subtitle">
                    Account: <strong>{selectedAccount.name}</strong>
                  </p>
                )}
              </div>
              <button
                type="button"
                className="contact-modal-close"
                onClick={() => closeContactModal()}
                aria-label="Close contact dialog"
              >
                &times;
              </button>
            </div>

            {contactError && (
              <div className="accounts-banner warning modal-warning">{contactError}</div>
            )}

            <form className="contact-form" onSubmit={handleContactSubmit}>
              <div className="form-row">
                <label>
                  Name
                  <input
                    name="name"
                    type="text"
                    value={contactForm.name}
                    onChange={handleContactInputChange}
                    required
                    autoFocus
                  />
                </label>
                <label>
                  Role
                  <select name="role" value={contactForm.role} onChange={handleContactInputChange}>
                    {ROLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  Telegram username
                  <input
                    name="telegramUsername"
                    type="text"
                    value={contactForm.telegramUsername}
                    onChange={handleContactInputChange}
                    placeholder="without @"
                  />
                </label>
                <label>
                  Telegram chat ID
                  <input
                    name="telegramChatId"
                    type="text"
                    value={contactForm.telegramChatId}
                    onChange={handleContactInputChange}
                    placeholder="numeric identifier"
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  First name
                  <input
                    name="firstName"
                    type="text"
                    value={contactForm.firstName}
                    onChange={handleContactInputChange}
                    placeholder="auto-filled from sync"
                  />
                </label>
                <label>
                  Last name
                  <input
                    name="lastName"
                    type="text"
                    value={contactForm.lastName}
                    onChange={handleContactInputChange}
                    placeholder="auto-filled from sync"
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Phone
                  <input
                    name="telegramPhone"
                    type="text"
                    value={contactForm.telegramPhone}
                    onChange={handleContactInputChange}
                    placeholder="auto-filled from sync"
                  />
                </label>
              </div>
              <label>
                Notes
                <textarea
                  name="notes"
                  rows={3}
                  value={contactForm.notes}
                  onChange={handleContactInputChange}
                />
              </label>
              <div className="form-actions">
                <button type="submit" disabled={submittingContact || !selectedAccountId}>
                  {submittingContact ? 'Saving…' : editingContactId ? 'Update contact' : 'Add contact'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => closeContactModal()}
                  disabled={submittingContact}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default AccountsPanel;