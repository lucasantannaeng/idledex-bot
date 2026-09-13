const { app, session } = require('electron');
const fs = require('node:fs');
const crypto = require('node:crypto');
app.setPath('userData', 'C:/Users/Luca Rodrigues/AppData/Roaming/idledex-desktop');
app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:idledex');
  const cookies = await ses.cookies.get({ url: 'https://idledex.com' });
  const response = await ses.fetch('https://idledex.com/api/auth/get-session');
  const data = await response.json();
  const result = {
    checkedAt: new Date().toISOString(), status: response.status,
    authenticated: Boolean(data?.session && data?.user),
    accountFingerprint: data?.user?.id ? crypto.createHash('sha256').update(String(data.user.id)).digest('hex').slice(0,16) : null,
    cookies: cookies.filter(c => /session/i.test(c.name)).map(c => ({name:c.name, secure:c.secure, httpOnly:c.httpOnly, sameSite:c.sameSite, domain:c.domain, path:c.path, expirationDate:c.expirationDate})),
  };
  fs.writeFileSync('D:/Projetos/idledex-security/evidence/test-session-summary.json', JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}).catch(error => { console.error(error.name); process.exitCode = 1; }).finally(() => app.quit());
