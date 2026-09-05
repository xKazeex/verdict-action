'use strict';

function authenticate(token) {
  return token === 'valid';
}

module.exports = { authenticate };
