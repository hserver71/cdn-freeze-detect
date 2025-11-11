import React, { useEffect, useState, useMemo, useCallback } from 'react';

const initialServerForm = { id: null, name: '', ipAddress: '' };
const initialDomainForm = { id: null, domain: '' };

const HcCdnPanel = () => {
  const [servers, setServers] = useState([]);
  const [selectedServerId, setSelectedServerId] = useState(null);
  const [domains, setDomains] = useState([]);
  const [serverForm, setServerForm] = useState(initialServerForm);
  const [domainForm, setDomainForm] = useState(initialDomainForm);
  const [loadingServers, setLoadingServers] = useState(false);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [error, setError] = useState('');

  const selectedServer = useMemo(
    () => servers.find(server => server.id === selectedServerId) || null,
    [servers, selectedServerId]
  );

  const fetchServers = async () => {
    setLoadingServers(true);
    try {
      const response = await fetch('/api/cdn/servers');
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch servers');
      }
      setServers(data.servers || []);
      if (data.servers && data.servers.length > 0) {
        setSelectedServerId(prev => prev ?? data.servers[0].id);
      } else {
        setSelectedServerId(null);
        setDomains([]);
      }
    } catch (err) {
      console.error('❌ Error fetching servers:', err);
      setError(err.message || 'Failed to fetch servers');
    } finally {
      setLoadingServers(false);
    }
  };

  const fetchDomains = useCallback(async (server) => {
    if (!server || !server.ipAddress) {
      setDomains([]);
      return;
    }
    setLoadingDomains(true);
    try {
      const params = new URLSearchParams({ ipAddress: server.ipAddress });
      const response = await fetch(`/api/cdn/domains?${params.toString()}`);
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch domains');
      }
      setDomains(data.domains || []);
      if (data.server && data.server.id && data.server.id !== selectedServerId) {
        setSelectedServerId(data.server.id);
      }
    } catch (err) {
      console.error('❌ Error fetching domains:', err);
      setError(err.message || 'Failed to fetch domains');
    } finally {
      setLoadingDomains(false);
    }
  }, [selectedServerId]);

  useEffect(() => {
    fetchServers();
  }, []);

  useEffect(() => {
    if (selectedServer) {
      fetchDomains(selectedServer);
    } else {
      setDomains([]);
    }
  }, [selectedServer, fetchDomains]);

  const resetServerForm = () => {
    setServerForm(initialServerForm);
  };

  const resetDomainForm = () => {
    setDomainForm(initialDomainForm);
  };

  const handleServerSubmit = async (event) => {
    event.preventDefault();
    setError('');

    const { id, name, ipAddress } = serverForm;
    if (!name.trim() || !ipAddress.trim()) {
      setError('Server name and IP address are required');
      return;
    }

    try {
      if (id) {
        const response = await fetch(`/api/cdn/servers/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, ipAddress })
        });
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'Failed to update server');
        }
      } else {
        const response = await fetch('/api/cdn/servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, ipAddress })
        });
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'Failed to create server');
        }
        setSelectedServerId(data.server.id);
      }

      await fetchServers();
      resetServerForm();
    } catch (err) {
      console.error('❌ Server form error:', err);
      setError(err.message || 'Failed to save server');
    }
  };

  const handleDomainSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!selectedServerId) {
      setError('Please select a server first');
      return;
    }

    const { id, domain } = domainForm;
    if (!domain.trim()) {
      setError('Domain is required');
      return;
    }

    try {
      if (id) {
        const response = await fetch(`/api/cdn/domains/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain })
        });
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'Failed to update domain');
        }
      } else {
        const response = await fetch(`/api/cdn/servers/${selectedServerId}/domains`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain })
        });
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'Failed to create domain');
        }
      }

      if (selectedServer) {
        await fetchDomains(selectedServer);
      }
      resetDomainForm();
    } catch (err) {
      console.error('❌ Domain form error:', err);
      setError(err.message || 'Failed to save domain');
    }
  };

  const handleServerDelete = async (id) => {
    if (!window.confirm('Delete this server and all associated domains?')) {
      return;
    }
    try {
      const response = await fetch(`/api/cdn/servers/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to delete server');
      }
      if (selectedServerId === id) {
        setSelectedServerId(null);
        setDomains([]);
      }
      await fetchServers();
    } catch (err) {
      console.error('❌ Delete server error:', err);
      setError(err.message || 'Failed to delete server');
    }
  };

  const handleDomainDelete = async (id) => {
    if (!window.confirm('Delete this domain?')) {
      return;
    }
    try {
      const response = await fetch(`/api/cdn/domains/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to delete domain');
      }
      if (selectedServer) {
        await fetchDomains(selectedServer);
      }
    } catch (err) {
      console.error('❌ Delete domain error:', err);
      setError(err.message || 'Failed to delete domain');
    }
  };

  const handleServerSelect = (server) => {
    setSelectedServerId(server.id);
    setDomainForm(initialDomainForm);
    setError('');
  };

  const handleServerEdit = (server) => {
    setServerForm({ id: server.id, name: server.name, ipAddress: server.ipAddress });
  };

  const handleDomainEdit = (domain) => {
    setDomainForm({ id: domain.id, domain: domain.domain });
  };

  return (
    <div className="hc-cdn-container">
      <div className="panel-header">
        <h2>HC-CDN</h2>
      </div>

      {error && (
        <div className="alert alert-error">{error}</div>
      )}

      <div className="hc-cdn-content">
        <div className="hc-cdn-column">
          <div className="hc-cdn-column-header">
            <h3>Servers</h3>
            {loadingServers && <span className="hc-cdn-loading">Loading...</span>}
          </div>
          <ul className="hc-cdn-list">
            {servers.map(server => (
              <li
                key={server.id}
                className={`hc-cdn-list-item ${server.id === selectedServerId ? 'active' : ''}`}
                onClick={() => handleServerSelect(server)}
              >
                <div className="hc-cdn-list-item-info">
                  <span className="title">{server.name}</span>
                  <span className="subtitle">{server.ipAddress}</span>
                </div>
                <div className="hc-cdn-actions">
                  <button type="button" onClick={(e) => { e.stopPropagation(); handleServerEdit(server); }}>Edit</button>
                  <button type="button" className="danger" onClick={(e) => { e.stopPropagation(); handleServerDelete(server.id); }}>Delete</button>
                </div>
              </li>
            ))}
            {servers.length === 0 && !loadingServers && (
              <li className="hc-cdn-empty">No servers found. Add one below.</li>
            )}
          </ul>

          <form className="hc-cdn-form" onSubmit={handleServerSubmit}>
            <h4>{serverForm.id ? 'Edit Server' : 'Add Server'}</h4>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                value={serverForm.name}
                onChange={(e) => setServerForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="Server name"
              />
            </div>
            <div className="form-group">
              <label>IP Address</label>
              <input
                type="text"
                value={serverForm.ipAddress}
                onChange={(e) => setServerForm(prev => ({ ...prev, ipAddress: e.target.value }))}
                placeholder="123.45.67.89"
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="primary">{serverForm.id ? 'Update' : 'Add'}</button>
              {serverForm.id && (
                <button type="button" onClick={resetServerForm}>Cancel</button>
              )}
            </div>
          </form>
        </div>

        <div className="hc-cdn-column">
          <div className="hc-cdn-column-header">
            <h3>Domains{selectedServer ? ` — ${selectedServer.name}` : ''}</h3>
            {loadingDomains && <span className="hc-cdn-loading">Loading...</span>}
          </div>

          <ul className="hc-cdn-list">
            {domains.map(domain => (
              <li key={domain.id} className="hc-cdn-list-item">
                <div className="hc-cdn-list-item-info">
                  <span className="title">{domain.domain}</span>
                </div>
                <div className="hc-cdn-actions">
                  <button type="button" onClick={() => handleDomainEdit(domain)}>Edit</button>
                  <button type="button" className="danger" onClick={() => handleDomainDelete(domain.id)}>Delete</button>
                </div>
              </li>
            ))}
            {domains.length === 0 && selectedServerId && !loadingDomains && (
              <li className="hc-cdn-empty">No domains for this server. Add one below.</li>
            )}
            {!selectedServerId && (
              <li className="hc-cdn-empty">Select a server to manage domains.</li>
            )}
          </ul>

          <form className="hc-cdn-form" onSubmit={handleDomainSubmit}>
            <h4>{domainForm.id ? 'Edit Domain' : 'Add Domain'}</h4>
            <div className="form-group">
              <label>Domain</label>
              <input
                type="text"
                value={domainForm.domain}
                onChange={(e) => setDomainForm(prev => ({ ...prev, domain: e.target.value }))}
                placeholder="example.com"
                disabled={!selectedServerId}
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="primary" disabled={!selectedServerId}>
                {domainForm.id ? 'Update' : 'Add'}
              </button>
              {domainForm.id && (
                <button type="button" onClick={resetDomainForm}>Cancel</button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default HcCdnPanel;

