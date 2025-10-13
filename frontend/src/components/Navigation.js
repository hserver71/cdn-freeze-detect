import React from 'react';
import { NavLink } from 'react-router-dom';

const Navigation = () => {
  return (
    <nav className="main-nav">
      <NavLink 
        to="/dashboard" 
        className={({ isActive }) => 
          `nav-link ${isActive ? 'active' : ''}`
        }
      >
        Dashboard
      </NavLink>
      <NavLink 
        to="/history" 
        className={({ isActive }) => 
          `nav-link ${isActive ? 'active' : ''}`
        }
      >
        History
      </NavLink>
    </nav>
  );
};

export default Navigation;