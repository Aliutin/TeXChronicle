const os = require('node:os');

os.userInfo = () => {
  const error = new Error('uv_os_get_passwd returned ENOMEM (not enough memory)');
  error.code = 'ERR_SYSTEM_ERROR';
  error.syscall = 'uv_os_get_passwd';
  throw error;
};
