'use strict';

// Some managed Windows accounts make libuv's uv_os_get_passwd fail even though
// USERNAME and the home directory are available. Tools such as tsx ask for this
// during their own module initialization, before TeXChronicle can start. Keep
// this preload dependency-free and old-syntax-compatible so it can repair that
// narrow platform failure before any loader or application module is evaluated.
const os = require('node:os');

try {
  os.userInfo();
} catch (error) {
  if (error && error.code !== 'ERR_SYSTEM_ERROR' && error.syscall !== 'uv_os_get_passwd') throw error;
  os.userInfo = function userInfoFallback(options) {
    const value = {
      username: process.env.USERNAME || process.env.USER || 'user',
      uid: -1,
      gid: -1,
      shell: null,
      homedir: os.homedir(),
    };
    if (options && options.encoding === 'buffer') {
      return {
        ...value,
        username: Buffer.from(value.username),
        homedir: Buffer.from(value.homedir),
      };
    }
    return value;
  };
}
