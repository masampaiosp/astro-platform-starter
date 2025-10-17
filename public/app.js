const runBtn = document.getElementById('run');
const base = document.getElementById('base');
const paths = document.getElementById('paths');
const tbody = document.getElementById('tbody');
const resultsPane = document.getElementById('resultsPane');
const summary = document.getElementById('summary');
const timeoutLabel = document.getElementById('timeoutLabel');

let timeoutMs = 8000;
document.getElementById('fast').onclick = () => { timeoutMs = 5000; timeoutLabel.textContent = timeoutMs; };
document.getElementById('balanced').onclick = () => { timeoutMs = 8000; timeoutLabel.textContent = timeoutMs; };
document.getElementById('slow').onclick = () => { timeoutMs = 12000; timeoutLabel.textContent = timeoutMs; };

document.getElementById('loadDefaults').onclick = () => { paths.value = ['/', '/login', '/api/health'].join('\n'); };
document.getElementById('clearPaths').onclick = () => paths.value = '';

function normalizeBase(u){ try{ return new URL(u).origin; } catch { return null; } }
function parsePaths(text){ const lines = (text||'').split('\n').map(s=>s.trim()).filter(Boolean); return lines.length?lines:['/']; }
function decorateStatus(row){ if(row.error) return 'err'; if(row.status>=500) return 'err'; if(row.status>=400) return 'warn'; return 'ok'; }

runBtn.onclick = async () => {
  const origin = normalizeBase(base.value);
  if(!origin){ alert('Enter a valid URL. Example: https://example.com'); return; }

  const list = parsePaths(paths.value);
  runBtn.disabled = true; runBtn.textContent = 'Testing...';
  tbody.innerHTML = ''; resultsPane.style.display = 'block'; summary.textContent = 'Running…';

  try {
    const res = await fetch('/.netlify/functions/smoke', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ baseUrl: origin, paths: list, timeoutMs })
    });

    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!ct.includes('application/json')) {
      throw new Error(`Non-JSON response (${res.status}). Snippet: ${text.slice(0,120)}...`);
    }
    const data = JSON.parse(text);

    let ok = 0;
    tbody.innerHTML = data.results.map(r => {
      const cls = decorateStatus(r); if(cls==='ok') ok++;
      return `<tr>
        <td><span class="code">${r.endpoint}</span></td>
        <td class="status ${cls}">${r.status ?? '-'}</td>
        <td>${r.timeMs != null ? r.timeMs+' ms' : '-'}</td>
        <td>${r.bytes != null ? r.bytes+' B' : '-'}</td>
        <td class="small">${r.finalUrl ? `<span class="code">${r.finalUrl}</span>` : '-'}</td>
        <td class="small">${r.error ? r.error : (r.warn ? r.warn : '-')}</td>
      </tr>`;
    }).join('');
    summary.textContent = `Success: ${ok}/${data.results.length} • Started at: ${new Date(data.startedAt).toLocaleString()} • Total duration: ${data.durationMs} ms`;
  } catch (e){
    alert('Failed to call the function: ' + e.message);
    summary.textContent = 'Error running test.';
  } finally {
    runBtn.disabled = false; runBtn.textContent = 'Run Test';
  }
};
