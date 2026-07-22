import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { createServer } from 'http';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = process.env.CORTEX_TASKS_DIR || join(homedir(), '.cortex');
const PORT = process.env.CORTEX_DASH_PORT || 3456;

// --- Static config (loaded once) ---

function loadConfig() {
  const statesRaw = readFileSync(join(__dirname, 'states.yaml'), 'utf8');
  const pathwaysRaw = readFileSync(join(__dirname, 'pathways.yaml'), 'utf8');
  return { states: parseYaml(statesRaw), pathways: parseYaml(pathwaysRaw) };
}

const configCache = loadConfig();

// --- API handlers ---

function readState() {
  const p = join(TASKS_DIR, '_state.json');
  if (!existsSync(p)) return { current_state: 'base', current_level: null, active_task: null, previous_state: null, session_started: new Date().toISOString() };
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readTasks() {
  if (!existsSync(TASKS_DIR)) return [];
  const files = readdirSync(TASKS_DIR).filter(f => f.startsWith('task-') && f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

function readLog() {
  const p = join(TASKS_DIR, '_free_explore_log.jsonl');
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, url, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  if (req.method === 'GET') {
    switch (url) {
      case '/api/state': return res.end(JSON.stringify(readState()));
      case '/api/tasks': return res.end(JSON.stringify(readTasks()));
      case '/api/config': return res.end(JSON.stringify(configCache));
      case '/api/log': return res.end(JSON.stringify(readLog()));
      default: res.statusCode = 404; return res.end('{}');
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (url === '/api/write-task') {
        if (!body.id || !body.task) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id and task required' })); }
        if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
        writeFileSync(join(TASKS_DIR, `task-${body.id}.json`), JSON.stringify(body.task, null, 2));
        return res.end(JSON.stringify({ ok: true }));
      }
      if (url === '/api/delete-task') {
        if (!body.id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
        const p = join(TASKS_DIR, `task-${body.id}.json`);
        if (!existsSync(p)) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })); }
        unlinkSync(p);
        return res.end(JSON.stringify({ ok: true }));
      }
    } catch (e) {
      res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid JSON' }));
    }
  }

  res.statusCode = 404; return res.end('{}');
}

// --- HTML ---

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cortex</title>
<style>
  /* ============ Windows 95/98 chrome ============ */
  @font-face{font-family:'MSSS';src:url(data:font/woff;base64,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) format('woff');font-weight:400;font-style:normal}
  @font-face{font-family:'MSSS';src:url(data:font/woff;base64,d09GRgABAAAAACBwABAAAAAAQfQAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAABGRlRNAAABbAAAABwAAAAchav/I0dERUYAAAGIAAAAHAAAAB4AJwBvT1MvMgAAAaQAAABHAAAAYHgki2JjbWFwAAAB7AAAAPoAAAG6knCX2mN2dCAAAALoAAAAJAAAACQMpBaCZnBnbQAAAwwAAAGxAAACZVO0L6dnYXNwAAAEwAAAAAgAAAAIAAAAEGdseWYAAATIAAAVsAAAMSzkviBgaGVhZAAAGngAAAA2AAAANhbyBDloaGVhAAAasAAAACAAAAAkD0kIQWhtdHgAABrQAAAApQAAAaTVZgSgbG9jYQAAG3gAAADBAAAA1P6xCmJtYXhwAAAcPAAAACAAAAAgAYYBOm5hbWUAABxcAAACYQAABTMps3VacG9zdAAAHsAAAAEAAAABnQoXX8lwcmVwAAAfwAAAAK0AAAEI04RHsQAAAAEAAAAA1e1FuAAAAADU+KjhAAAAANrGEIl42mNgZGBg4AFiMSBmYmAEwgwgZgHzGAAIFgCXeNpjYGJhZJzAwMrAwsLAwsDA8N8NQgNxGuMsBggLBhgZkIBbcEgQgwODguoftrR/aQwM7G6Mc2BqOHbxigMpBQZGAI5GCYMAeNpjYGBgZoBgGQZGBhDYAuQxgvksDDOAtBKDApDFxKDIoMagyaDLYM0QzRDHUM1Qx7CAYa0Cl4KIgr5CvOqf//+BahUYlBk0gGoMGBwYYhkSGGrBahgUBGBq/j/+/+j/w//3/t/5f+P/9f/X/l/9v+X/igdhDwIfmD/guJUDdQMBwMjGAFfIyAQkmNAVAL3EwsDKxs7BwMkF5HMzMPDw8vELCAoJi4iKiYOUSEhKScvIyskrKCopq6iqqWtoamnr6OrpGxgaGTOYmDKYmVtYWlnb2NrZOzg6Obu4url7eHp5+/j6+QcEMgQFM1APhIDJlFTSdAEA6j46SAAAAAAAugC7AXQBdQIuAi8C6ALpA6MBdAF0AXUCLgIvAugARAUReNpdUbtOW0EQ3Q0PA4HE2CA52hSzmZDGe6EFCcTVjWJkO4XlCGk3cpGLcQEfQIFEDdqvGaChpEibBiEXSHxCPiESM2uIojQ7O7NzzpkzS8qRqnfpa89T5ySQwt0GzTb9Tki1swD3pOvrjYy0gwdabGb0ynX7/gsGm9GUO2oA5T1vKQ8ZTTuBWrSn/tH8Cob7/B/zOxi0NNP01DoJ6SEE5ptxS4PvGc26yw/6gtXhYjAwpJim4i4/plL+tzTnasuwtZHRvIMzEfnJNEBTa20Emv7UIdXzcRRLkMumsTaYmLL+JBPBhcl0VVO1zPjawV2ys+hggyrNgQfYw1Z5DB4ODyYU0rckyiwNEfZiq8QIEZMcCjnl3Mn+pED5SBLGvElKO+OGtQbGkdfAoDZPs/88m01tbx3C+FkcwXe/GUs6+MiG2hgRYjtiKYAJREJGVfmGGs+9LAbkUvvPQJSA5fGPf50ItO7YRDyXtXUOMVYIen7b3PLLirtWuc6LQndvqmqo0inN+17OvscDnh4Lw0FjwZvP+/5Kgfo8LK40aA4EQ3o3ev+iteqIq7wXPrIn07+xWgAAAAABAAH//wAPeNrFWluPI9dW3nW3q3ypstvtvk7HdGaSTE/GGVt9GJMciUvOSIgnQEFCOj1CCKQgcaeHB5AAIYGQpt/heSZvSGhvT57s38DDzEM/8Yy6j8Q7maQ7fN/au8rlnokUxEEnLY/tcqX2Wt9el2+ttZWvPlXK/73oMxWoRN03nhp/Mk/C/L8mJo7+45N54OOjMgEvR7w8T+Lim0/mHq9Pi1Fxe1SMPvXfuX7X+5frz6PPXv/rp+G/KzwSL+Wdxmfy3Adqjq9HxvMudTT2dGOs1bkOJyZIL3U8MUl6aZrekTKRV/R0OPvowYPj0cDD473T6zPvdLHwTqOt1xfuudEQz91VB+pv1HwHz9WDqVZj0x9Op1zCFHuTiQ7HpnsLFyJcaLZxIRnrbOrpd8Z659z48WRitrFsA/fOd7bToxe/uKOaRxBKb+dm0zsy6T5uGbQuTSvHLYNN3jLo45bOxIwg7EcPiuNpcXhMFOQ1OJTXqODrNn5aUO6F9wTvi+uni1KThT/GxeunfC2uXsp1+c0fK0+pbx+FJ9DvQH2uoJUeik5z5XF9tYf1e9AMQCYTnY1Fnz3ok0LYXejT6kHY3T3evDvEzflkvrfLb3vULraimx5wfhHFg813hwD7hx5kPob0x1PAPsUftYECg8PB6PjwmGKL4EsIvFxC4EozfLOq8Q5ujezPS9mf99SR+nn1sXqt5j/g7j+E0Nime1O3TR8+wK58PNbbUzPGT8FE3xnrYmrex5dsoveg5iFu3cet7RFuPRqbA//S05+I9eyJvvr9id7NzT3sV/wBIHgICDZ+Djc/zPXtd84Lc6d9iccan6Zwu31pNt/Bj/dy/QP+2LiPq8edS5N/JP+LmXlHujUxUzwYu/xDPHX3TtEzYTSb6XuF3prp2z29PdMPC5NmuDbr6d5MHxe6P1NQAsY7nOk7xbyZbs1mgiwxLf9Gg8Pan+fQJsYfe8eH/RvfiehiSeyXtJ+zhX9/sbh6JZdhQbQcor+wv9t/whN37fXlwv5X+qLY1EBtq39Q8w3uxiZQLiY6H+utqengi0efgYuYKLjUTfqLp3fG2j838QaQbQOTxmTe9mlM7QzG5OdaAUUdTs0mfmznZpgdmSK9nBdD3lR0aazYJlrc5gbAUTOdF3oAYI7hMjS4Ec2sGInrUO3SaaDhcvnNieh633vinS6X12fO0LxTRT+5PvPvQ6dM/bLSzbFJoEI8NiEtpEULYVTRKQX0p6aJz4g3bYqSNK0ocYEwlsk+DUQUK4Qsj3Xip8vlV/DdtbUeKTidUTTX1VreuWng+RnXCqYmxefIraUyrNWY6aAwcRMGE/Z0wvUYOET3wWhxY0GsB539C/8CsfOAMUC8BS+PQU3BKAMYciQhqI+n8G6YRm2fM9VVv6vmKfe5BVm7YxNQ1lxwaUG+Vk75TILwVuC9pYre3A9SgGGSNj6HDUgLm26lMP9EQfJu8aXnR40MEUMHPR3bTSyVOJ4iDyz8i+XyamvBcLaIhsslrTAaSirgP/4FZEvUR2oeM2pbxQCkJIT4XPsTE8F64ojWEyNeSVJgnB0djyQZ8MnRcLH86hSP9Sp999UfuAyziwe2xtBNjDtFCKHet7hHdGxGjFQiRgNa91uXDCMHdHMGxDDqdKleo9CbM93vmXwoGOziNy9p9CVYPiicO8NqR8clAPYPeyGuSme9EEfE6qfOXwHNy9Ila7Lvqn+0WcwEEh9dwKctJ29VZk/CX8smTygT5CZE2GpMzBD6wN/2aSHY0C/jpNPdgdBmGEKDfGNrG1+UiaGrGWxiTxMGLt3q6Q2bBRD3BemaYnZ3LfJ8OdVkn+mbK9UYmmo22FV92mCHO92VuJJ7VVzZGOsO4kpRiyudKq4gkISI2uF4HrZ5MaQlDKBUB2roHBokOTTwevTcbW+KUAJpXe59b3psQwgDhnzAH+PH189cAq5hP1B/4aKhw76osG/7MERZPm5AJmxDk+BvCvgNAd/ErUkJvyla3AwzdNgDUVNA3Hmn1xdHEtC7+WwFdPWqQ3x9Fp5cDf37Jb4Xi+ALKCLf1Fos76uh+ms171H6Dcg8HJsMb40xGQ+DeeqcfkucfsMay0ZOJKlAtyXUaxsCb1jv79H7uwM6QisvxFQ2epSa7j8s5u2cquispzsr5x9Yg1kPAtdPGTDXY4EkLNqIf3/N/gv12EYqiQcUuDfW6Tkj9jxtcgNSMpc01y2mbAb1Zm46yDSMFZGYTRTAQvqMZwjtJi8IuELk0sFMogdSzKGwMmsr4clyYSlL9JKyQtqrV0gzMBSCHKxhvKv+uIYybKQLG4mQ7iaEfMu7LLNmLNa9C7ddeSlSDoHfmugehfdj8I2iC9ZJy3F7sW33IhXHVRbYKjXWgCXOYhLO+0qPtE5YuaB8u2Enf+k0CFYaWCsvDaeyE2faeqOKKwMRT+yEhv0iTrMeY0qX1t0i1rSTmGmiIXbyopm2OyWvlIhyWMsTfVygqYuotXSxKNVgzkDyG1c1RHgiNcSHtRoCaTCiyN9VR7j6gS9XPwTPlkvnP98+8u/jmQmy5CfumQi086gEqOFcXRI78QjFdSRfhvTiKIbKWMISupGkYKwBJSTWhz/GUrJOQwH/DyD5f6r5IR9/B+u8R1MnQZmau1itP9Efjk3hI8E3YRPIVIOpCQOh9zuipo5ysxdinyaevi++fEDe64jNISLlDlh9ylSmD+AZFPMOAutduMddcY+7t+FAd3NzxJwnSOl+jr0/MhkAG+P9cFRtpr5b6PbM9I9wZXNrm1c2CtLajEQG2fAQfnXA2xCz3+HPH5aBjbEYZjqQesjuOmne8aFlvoVUFhIwpDryToPn8LjXF0yTCBA2PQZffP0M0QOm4Z0yezKOXw0Z0K9eMtcgjgxdOQIi6Ff1Bu38b+1+ioEH4qI9a+PMOVvCZemOZK0CBDwwRiBp2piSA4guPnZz3eYdqP30AJnAWX/fd5WAyRllyP+RiUBrXwRZa7PkBvI3qt5HRd+6LeRnzBFNaJLCap8w+Fy9sn7MAFSLPZlk0D9zFupYHFNo34XJjYrM5RPH50ATTLMlTJf5sgkm98KHw0osJ8fTTRI5+Am2LYcl02P7hQlg0dpzlXexCjy3Xdih98BVX5UhJz5bjzYunktd3le/46IN01Euht6RLbiZmKwCGZlzDgXrWYnSZ/Ws1CIntcHmRuqxTni8CJ4viCVxXaBwsCnHlkGq3jfIrIQVqm/CCSy7lhuLHZAU1EDtEtQgzfw1UAliegNERwxvj6RNQBDBlAgiDQEQLmx9A8Hr+TBTv+Ska67SeeiEtIWNLWbmTUXnbgbMjhN8SJAE2zb61diF5RMA5rLatbX821S/4Lzmxlrp29dyC2U3FiqXcYtsrdnEQP2541nWJlBzvM0gNusG0bEG0ReDmHf6XL+TY+XhyjY2aBv9jvSMlMneKDFrVjK1llzZiQRs//Lr5ytLwaVvHi/qcmdq5rBJpiIl5R3raFruBGX1JxQX9QQthAVVtQfVn3V3LhufXW36P/nq1L8QiOxark924Nbyxiz0+HiSTL6i6om89atT9/8Fz0TG33aVHqSbBylxCnzYBBttrfIxJU1lhmyXHDVFsYcsbljrKdyFjyqBEUeFaWQzgdC2tiw/JUCwHqnBXr2+v1is7fGB+js1HwqPm8JRLokXmBD2V3pULm2hxOsiYyFP7XjSjmKQbUz0nmsk9G2uHUHEne4qJ8G92lt4H7D7osxgCFG3d3AhLb6M4mD/lgu/o6LWZ5F8IznnmDnosJD22xPXLbl+irf4zHa07DdJLq9qvhGpu84X7c574EwO0HkgHhFETdKHasMHTFrxGdApsbG56TO3t9mUBtSclvGmbzGJgEm/noHKeOicIe4IXRuwpeApcpD2rFTYvWzbUZREruEmsQCiguw0ek9gc/cZvaHgjXj94+8lWylQy3onBOqIQCbqS1WmO8U8TiwdFBH5uUwnLhliD8p9kA6o7IA0doIvvrL2tbUeq382fQzECAZnxrMbfYyVbE3VVr+1ipwpxGu7yNmpIicqLhCLjChBQmaVKKOEcSJSpQ1AF810++0peLTtQZrwhJSnHluDZ5JzhWOKLF1wn39SCNI2wkrRXXIFR/FrpWBOymA3dGA3FAG2ldGcW32YM8lOboHs0PlaSIGkfyZsUGhhPwIlvLLRBdJDkiA/ij3xwhWaEnuBKAmgQ5Wxd8tytxq2Ng2u49tGZfj7Dt/mlAU4WUSxqhGhSVv6tGwYpFCmW5EfloJN7rgfz8okndBCLePBDxbu4gbjgZQV5I5NrFBnyBbk672bv/qu3k3fJrq27Xn0XI21V6+xemD45JlxiqpwG1Vha6PqJ4DTSTunY6vCWs8GoLPQeqO6WivEaxVWrRavaqyqFq/pkqiHVV+OXUzPFVjxuS2047LQfmt/jpKAA3Ax1NTL1+Po5Voe/fVVjlrPoPXc1Poeucmr56ZRlZsq2ofEVCanVfwdssfWc7qhVvdC7or4w6aoZ0sCyoJiq2e72Lqw1UGbPDCX7q60eeHsLJukIN6UTg8SJhiHaRQFWyPwZt1lA6JHohglDUYaZ2q0rjJglz2Jw1rQRmJiLRwNhS2g3rHv7AtxS8XtrV6NheTcf6smYCZKxNT2pLjhKCxoXpokg0m5kj9kRSTJ+NabSu9A02183HYlUUtKok18lDIIHuZQkS4MkpTk6OAWVN4TAPZnpjUoZB5S2HlItIcYUuzfYgwJCvyw0n90A4NRHQdmK1tK295MHY+bmLyBi+z3kbpU8yPicggYIvCNiXyVqnBEH9MRCcc+anBcuT2hoe9OTTeUgrwljtzGl4ENLjFwAXL3ys7rkY07Pp+RTs0HtgY7ys278NyNiTnEhc2JPsz1SGZQLc6gdG9qRi02g8yHgO7IZ3piPJrpD9x04E5vnuzt88q7xXzn1gE/jXp6lx7A4dJ7gvT7M0kcpujNav1oS3FGMsKwnI1/QoD4TcYbNtLWjE1q0mXZuVi6pCz/2qGTLVbWfenvnS9tiFkFofQq6o6lPVhObK1tq+7lPa/yrIbrPmyvGqa6VwCQwcxGaKZIduI70nmgQ3GEZOJoVtpRXVFR8fD4rX5UKvTNY5ZgdV0O1B3H7/Y94TPSYH9nbIeknX12mYs6yG6Odzwq6pM82/ZfLL9+Hr20g7jwxAFqR6a27b+aIyVqrMr6B+WWX/WyQFou3RiEQx4SZBtiobAQWg56rs8aSgZFSq0986E8sz6bwjOTcx1MTMxn5cZLJfriEx+Ou+zD7TSKbQphPPHT5X+7Z0fD8CR5BH7xnip3WBJaueuALAqFkJF+2ZH4aojMxpgbG9uxjQWneraTe6RQq7gMWqUdYBG2L2sJZmprEJtf6nPN8ES4wh+qeYs76VhC4EYoK7LQodNKaU+KANoz7wrn6baQyOQ8AGlD1i1sn6vTstVkwSlhm4QyDmAPzXRWchz+0blc25s19gVnltLPtO6FepLTynrfvsYbS9IY+La4sLwxtTVlanlj4nhjktXYbOoITdsRGsdjbQVSNm6YFMumDcrOl8IA/Iuq9gdub+vVtN86RPjp9mocLWGop1R2ViYEZfEGVr+h5o0bWEVrWFmgyuKbWKVWmsaKYytihX1szqrdk3rE7Zz3pNw2iOKPUYr4F3X7KtRA/ZGa52VXpiNIuXFLz5M2Ya2D0bTkrmlpaX8iFCK2w6GmlS0nUu2USHW6Iueg9zYSvQKtjw8U72pYwlYKvJSpnGV3q1mrnVf/mmPQrhhfH5Bn0gueZ1LJZk05/SIMjNtp/EDmVgk/emUQHLlDLjZh0BWRP755TKw4unK++CcK5bHzxbYNSXDJhvPF6FyrSemOniXuKbaO7teJAElAgoskR86btWSY0xZKSBqRgce7ExlFIVkCAYy+aPvNgIoMHmT9FWsKyGYHa3ZygmKDo/V6/6utfnW9x7PmjG3rjG2bsCpnbLiWkzhiJHLVHVDSg3R9GP4X4n3MPrYvtn426l7V9fnOsUawGmuwBVSNNcITZhwZbAj+1TPvSrT+Xk9kJl09kdH19Tj5kTxzhdGQVXjP9Xa61uxjh5NN8EOL01DGClyom67Gi0PXLkftDRaoTJdTxf6G5PcXYTDYrHVvRivaYvs2lhNKfnVYbrpjL5aZ/B97aNFLsdnfdBE5ak5Za8IW6qV82x5vSb1qVhB7Mn+0JX0MI/DLOjO4UVeWfRnkP0u1whOxBfuqnQWAHJn6FSd/NCXG/rqvZm5dVydV6zbcuv6NdWGDYDxEza1Zsz+33s/+nIj7LBFX1eKIy5NV7IdB/7T6KyRTq/4Khxs2Swq3gCxkVBBnXZZ6HorHLhXdyEPYHZ1NKln+l3koeM6WQ4XK67F3usrXMrOs+pEVa7T9SCnQVTUJr/qRMADkBNl8VfWM8ZwD9c9qfqvWt9i1xG6bCZ/zDqa27gRZn+cgypKRQ2uzD1LW2WJR6YofNy3ez/Uuax0OS0OpdXalKlqVifFMh8U82RzaFmHgJqk6ZfFMjr/pmhquljkuiUMZDlwX2mU6m/LKA3GLRRUU6jkwegkb/8x1xtwJMWzbPJBuRuA1j+qHxfzJPBEUk6gpDEdM33Yj6sfGkINcb9wdGbPFKs85lEc1bvh0vfeR3Ox90Keb670P2/Hgal5ttWPLB2wbG4wleM4mJWcYtfW66keWCXNfE1uSRZPSp92SreyojChhVrk38myLvbGwLLHKstz2lYV3yEHEi/L4atmYqMXSvvrc5Yq2nMrNujzu2UAAbk4mJZGU9hfNpVgbTeikKgwhmp3CdlpSmXEKu2p/B8nsjW5KOWpxFWApnH9pRfWeXA3LjkHdF0TeG1Njd6LDdYk2yuS5mp3njgHbaQUZcF9JMDbdHO8t1wNn35Q23+jNHIFyp1Aor/3XleMLe3yAENeRlQTnffvo+kxkLWDLZFLKnjppTIVPBecm5tBgUpp1AesNcu0JfKlUfgnDUSocC7vsGlUh+FOXgiWjlVwwaR5KtFKJYcPFEA8vr4Z8UU61jl9ZQxe1wxMbbljBnpjxsnoNvaqepW6+eoW8JKc8T8scb/3n20f+BWpP2Z82nw/iMS9qBwdJQjxbm/Tk8KA9SqZzN0tyFIS7k/eqib1QyUwaic0WKQj4ZpjK/vA8t6W4bAZL6LH7487fXiz8n0DgzcUqX9Xl/FOHQx9y5vbYm2RVFOUNJ6d3zpOhbMBnsCPKCQ/tpVJSU06ey2Ymzwuhl92Sh+tWYSlvIjS4YYPCg6kcFbInSadu4xYridcEFlnDk2iImNjFntXq+YiFvG5OJUIlkxvlPAOyLUEOedSUp76vXi6kRV72NVbnVVX9QKrg8//0W7io/Raqtd8a9d8atd8YIx+Hj/Hb7Zs88cugq5LwyL3V2CL/h6+f4eb/AW1BXggAAQAAAAEAAMT+rKpfDzz1AB8IAAAAAADU+KjhAAAAANrGEIn/Rv6MCLoHRgAAAAgAAgAAAAAAAHjaY2BkYGB3+5fCwMBZ8t/t/3+OXQxAERSQCQCW5gadeNp9UMENwjAQc9IWygRs0ScToG7RNx+e3aJbwI8RskW26IMd4Jy70CiqiGT5kvgc5/wbV8jyL8Gg6KLgDBwWZb8qmgcC98Lp/B+Sl/T0YfNJvrHQ2Z7adqrejTso+qg5zcoZOWfOvJtrrTIOW/3LWemZreyjjmft9BnJnEeaif2Fc2qewHGU2tjfASf37qKA+DnJj5vpDd2MIP8KvKOe/l9inTWtAAAAeNpjYGDQgcIIhhOMGoyfmGKYJjGdYnrGbMIcx7yHRYOliuUGqw1rF+sbNj+2CrY17AnsJzhUOEo4jnD84dTj7OI8wHmHS4Gri2sd1x9uL+4Z3Pd4PHhm8TLw6vHm8d7iS+MX4a/i38b/QIBPwEYgTmCLwC9BL8E+wVdCKkI1QruEngjzCScJ1wkfEv4l4iHSJ3JJ5Jtojuga0SdiKmI1YpfEZcR9xBeIf5NQAkIDHNBOwkciSiJDogwMpwEA5JQ26QAAAAABAAAAaQA8AAUAAAAAAAIAAQACABYAAAEAAPoAAAAAeNqVVMtu00AUPY4DhQqyqSgSAmkWlRASiftAULKDSgEWSKiR6AYh2a6TuHFettMk3bDlL/gKhPgDoCuWfARfwIYzNzchqboIsew5c+fec58TALecAhzY3wYe8OvCKV7nusXdFDvErxUXUMJAsYsqPigu4hG+Kr6CTfxWfBVbjqt4DWPnvuJreOh8Ukwt51zxOt47PxXfwMeCp/gm3hS+KC7hnbumeAOHbqj4Gzbdz4q/Y9udcf5Ayf2j+BwliZz4l4s7xdu1+DQyQdw0g6EftuNu05xF/dYkzcxJL8lNZ2JG/tgE0TEO0EMfE6SI0UQLOQwSyoZcd7GNHTxhmerc1eGji0xQJPoN4ufUTXCMQ8qatEqolaJGaZdcdb4ppaHwrsKzio654O2t6GTUsl4NY64wcstUnjOVF5jKc6bL44zFs8/XSn3qReiIpzZlPYmlRptXss4YWlJJQ6ndW19d2uQalU9/Bi/IE+Cl1DmndhUen4ZyZAtRVPjtUdubdsPcXaUy5h7xiBr2PCBTTGkusphraynef77W/yuey06nOWY8zaQOI6Id7GGfF2gfjzlJHm1tF7J5P7KFfgTajwNKIq3aKZGR+ezw6WnWzyRSa2fzy+c9t/X3xdrqJJS3iZfzCi+wh0vcFa4pp8oT65DnXYnRZhXwhkxj95iVnS6PlZzFGMjdMfwLGVIjpOeYtlZyxvM+o5jIfBqcSJ62Ix3Kpr0aC0PE7I/4Deb1nc3xkZzZrPpksbdyV852mJW9nVXun+ptta+d1gZ5h+Kpr3cj4j6bd9/WayDzkUpNkr+GSNozAAAAeNptzMdOAmEYheH3A2RoKkqxu7H3fwaGYosEGHvvNZIoMIkxRsPC29L78JKM0fmXvpsnOYuDj7++v6jzXy6IT/z4CRDEIESYKDHiJEiSIk0PvfTRzwCDDDHMCKOMMc4Ek0wxzQyzzDHPAgoTiwxZbHLkKVBkkSWWWWGVNUqUqVDFYZ0NNtlimx122WOfAw454pgTTjnjnAsuueKaG265456aBKRNgmJISMISkajEpF06pFPi0iXdkuCDT0lKStLBxtP7S9P0sIzWs6tUSWkrv1pKKa2ptbQZbVZra3PavLagLWpLnqb+Nc1I3W20Xh8fam9Nb7IcT9vTdso/KldFFXjaRY09EoIwEEbzRxIIoAWtM1jnGkJD41iRGQ/gCSxs1MJS7+AFnMXK8XK4wUS7vO+9zL7oeAF6JR3odT9QenNDK22/hLnroNrg4+QWIO22J0DrBrhdAaubN6FiR5idmNfNk5kAwksuzlEmKIUOIL1MxCNKhVKqANpLJe5Rpih1+gUKWThufJUdR6wG3u5xyf1ipothKfBnrn9Y+qBgh38ww6BUER1U9gOKK0YfAAAA) format('woff');font-weight:700;font-style:normal}

  :root{
    --w-face:#c0c0c0; --w-hi:#ffffff; --w-lt:#dfdfdf; --w-sh:#808080; --w-dk:#0a0a0a;
    --w-desktop:#008080; --w-navy:#000082; --w-navy2:#1084d0; --w-well:#ffffff;
    /* legacy vars the render JS still references inline, remapped to the palette */
    --bg:#ffffff; --bg2:#c0c0c0; --bg3:#c0c0c0; --border:#808080;
    --fg:#000000; --fg2:#202020; --fg3:#5a5a5a;
    --active:#000082; --completed:#0a7a0a; --paused:#9a6a00; --abandoned:#b02020; --blocked:#9a6a00;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{
    background:var(--w-desktop); color:var(--fg);
    font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif;
    font-size:13px; line-height:1.4; zoom:1.15;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  }
  #desktop{ padding:10px 10px 46px; min-height:100%; }

  /* ---- bevels ---- */
  .raised{ border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }
  .sunken{ border:2px solid; border-color:var(--w-sh) var(--w-hi) var(--w-hi) var(--w-sh);
    box-shadow:inset 1px 1px 0 var(--w-dk), inset -1px -1px 0 var(--w-lt); background:var(--w-well); }

  /* ---- layout ---- */
  .grid{ display:grid; grid-template-columns:1fr 1fr; gap:8px; max-width:1760px; margin:0 auto; }
  @media (max-width:900px){ .grid{ grid-template-columns:1fr; } }
  .full{ grid-column:1 / -1; }

  /* ---- window ---- */
  .window{ background:var(--w-face); padding:3px;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh);
    display:flex; flex-direction:column; }
  .title-bar{ display:flex; align-items:center; gap:5px; height:20px; padding:0 2px 0 4px;
    background:linear-gradient(90deg,var(--w-navy),var(--w-navy2)); color:#fff;
    font-weight:700; user-select:none; }
  .title-ico{ width:14px; height:14px; flex:none; image-rendering:pixelated;
    background:repeating-linear-gradient(#fff 0 1px, transparent 1px 3px) 0 2px/100% 100% no-repeat, #000082;
    border:1px solid #fff; box-shadow:inset -1px -1px 0 #808080; }
  .title-cap{ font-size:11px; letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .title-cap .sub{ font-weight:400; opacity:.85; }
  .title-btns{ margin-left:auto; display:flex; gap:2px; }
  .tb-btn{ width:16px; height:14px; font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif; font-size:9px; font-weight:700; line-height:1;
    background:var(--w-face); color:#000; cursor:pointer;
    border:1px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh);
    display:flex; align-items:center; justify-content:center; padding:0; }
  .tb-btn:active{ border-color:var(--w-dk) var(--w-hi) var(--w-hi) var(--w-dk);
    box-shadow:inset 1px 1px 0 var(--w-sh); }
  .window-body{ padding:8px; background:var(--w-face); }
  .window.collapsed .window-body, .window.collapsed .toolbar{ display:none; }

  .toolbar{ display:flex; gap:3px; padding:3px; border-bottom:1px solid var(--w-sh);
    box-shadow:0 1px 0 var(--w-hi); }

  /* ---- generic Win95 button ---- */
  .w-btn{ font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif; font-size:11px; padding:3px 10px; min-width:60px;
    background:var(--w-face); color:#000; cursor:pointer;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }
  .w-btn:active{ border-color:var(--w-dk) var(--w-hi) var(--w-hi) var(--w-dk);
    box-shadow:inset 1px 1px 0 var(--w-sh); padding:4px 9px 2px 11px; }
  .w-btn:focus-visible{ outline:1px dotted #000; outline-offset:-4px; }

  /* sunken white listbox well */
  .well{ background:var(--w-well); padding:6px 8px;
    border:2px solid; border-color:var(--w-sh) var(--w-hi) var(--w-hi) var(--w-sh);
    box-shadow:inset 1px 1px 0 var(--w-dk), inset -1px -1px 0 var(--w-lt);
    max-height:40vh; overflow-y:auto; }
  .well.tall{ max-height:52vh; }

  .panel-title{ display:none; } /* legacy hook, titles now live in the title bar */

  /* ---- state banner ---- */
  .state-banner{ display:flex; gap:24px; align-items:baseline; flex-wrap:wrap; }
  .state-name{ font-size:24px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
  .state-level{ font-size:14px; font-weight:400; color:var(--fg2); }
  .state-meta{ font-size:11px; color:var(--fg2); }
  .state-meta span{ margin-right:14px; }
  .state-flash .title-bar{ animation:flash .45s ease-out; }
  @keyframes flash{ 0%{ filter:invert(1); } 100%{ filter:none; } }

  /* ---- pathway ---- */
  .pathway-bar{ display:flex; align-items:center; gap:3px; flex-wrap:wrap; }
  .pathway-step{ display:flex; align-items:center; padding:3px 10px; font-size:11px; font-weight:700;
    background:var(--w-face); color:#000;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }
  .pathway-step.visited{ color:#000; }
  .pathway-step.current{ color:#fff !important;
    border-color:var(--w-dk) var(--w-hi) var(--w-hi) var(--w-dk);
    box-shadow:inset 1px 1px 0 var(--w-sh); }
  .pathway-arrow{ color:#000; font-size:11px; }
  .pathway-none, .tl-none, .empty{ color:var(--fg3); font-style:italic; font-size:12px; }

  /* ---- tools ---- */
  .tools-grid{ display:flex; flex-wrap:wrap; gap:5px; }
  .tool-chip{ display:inline-flex; align-items:center; gap:5px; padding:3px 7px; font-size:11px;
    background:var(--w-face); color:#000;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }
  .tool-chip .src{ font-size:9px; color:#000082; text-transform:uppercase; font-weight:700;
    padding:0 3px; background:var(--w-well);
    border:1px solid; border-color:var(--w-sh) var(--w-hi) var(--w-hi) var(--w-sh); }
  .tool-count{ font-size:11px; font-weight:400; }

  /* ---- timeline ---- */
  .timeline{ display:flex; align-items:center; gap:0; flex-wrap:wrap; }
  .tl-segment{ display:flex; align-items:center; gap:5px; padding:3px 8px; font-size:11px; margin-right:3px;
    white-space:nowrap; background:var(--w-face);
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }
  .tl-segment .dur{ color:var(--fg2); font-size:10px; }
  .tl-arrow{ color:#000; margin:0 3px; font-size:10px; }

  /* ---- tasks ---- */
  .task-row{ display:flex; align-items:baseline; gap:7px; padding:3px 4px; font-size:12px; }
  .task-row.highlight{ background:var(--w-navy); color:#fff; }
  .task-row.highlight .task-date,.task-row.highlight .task-disclosure{ color:#cdd9ec; }
  .task-icon{ flex:none; width:14px; text-align:center; }
  .task-title{ flex:1; min-width:0; }
  .task-title[contenteditable]{ outline:none; }
  .task-title[contenteditable]:focus{ background:var(--w-well); color:#000; padding:0 3px; box-shadow:0 0 0 1px #000082; }
  .task-badge{ font-size:10px; padding:0 5px; background:var(--w-face); color:#000; flex:none;
    border:1px solid; border-color:var(--w-hi) var(--w-sh) var(--w-sh) var(--w-hi); }
  .task-date{ font-size:11px; color:var(--fg3); flex:none; }
  .task-disclosure{ flex:none; width:13px; text-align:center; cursor:pointer; color:#000; font-size:10px; user-select:none; }
  .task-disclosure.empty{ cursor:default; color:transparent; }
  .task-children{ border-left:1px dotted var(--w-sh); margin-left:10px; padding-left:8px; }
  .task-actions{ display:flex; gap:3px; flex:none; }
  .task-actions button{ font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif; font-size:10px; padding:1px 6px; min-width:0;
    background:var(--w-face); color:#000; cursor:pointer;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }
  .task-actions button:active{ border-color:var(--w-dk) var(--w-hi) var(--w-hi) var(--w-dk); box-shadow:inset 1px 1px 0 var(--w-sh); }
  .task-actions select{ font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif; font-size:10px; padding:1px 2px;
    background:var(--w-well); color:#000;
    border:2px solid; border-color:var(--w-sh) var(--w-hi) var(--w-hi) var(--w-sh); }
  .btn-delete{ color:#b02020 !important; font-weight:700; }

  .new-task-form{ display:none; gap:6px; padding:6px; margin-bottom:6px; flex-wrap:wrap;
    background:var(--w-face);
    border:2px solid; border-color:var(--w-sh) var(--w-hi) var(--w-hi) var(--w-sh); }
  .new-task-form.visible{ display:flex; }
  .new-task-form input{ font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif; font-size:12px; padding:3px 6px; flex:1; min-width:120px;
    background:var(--w-well); color:#000;
    border:2px solid; border-color:var(--w-sh) var(--w-hi) var(--w-hi) var(--w-sh); }
  .new-task-form button{ font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif; font-size:11px; padding:3px 12px; cursor:pointer;
    background:var(--w-face); color:#000; font-weight:400;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }
  .new-task-form button:active{ border-color:var(--w-dk) var(--w-hi) var(--w-hi) var(--w-dk); box-shadow:inset 1px 1px 0 var(--w-sh); }

  .inline-note{ display:none; gap:6px; align-items:center; padding:4px 4px 4px 22px; }
  .inline-note.visible{ display:flex; }
  .inline-note input{ font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif; font-size:11px; padding:3px 6px; flex:1;
    background:var(--w-well); color:#000;
    border:2px solid; border-color:var(--w-sh) var(--w-hi) var(--w-hi) var(--w-sh); }
  .inline-note button{ font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif; font-size:10px; padding:2px 9px; cursor:pointer;
    background:var(--w-face); color:#000;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }

  /* ---- findings ---- */
  .finding{ padding:5px 2px; border-bottom:1px dotted #c8c8c8; font-size:12px; cursor:pointer; }
  .finding:last-child{ border-bottom:none; }
  .finding:hover{ background:#efefe7; }
  .finding-header{ display:flex; gap:8px; align-items:baseline; margin-bottom:2px; }
  .finding-state{ font-size:10px; font-weight:700; text-transform:uppercase; }
  .finding-time{ font-size:10px; color:var(--fg3); }
  .finding-content{ color:#1a1a1a; white-space:pre-wrap; word-break:break-word; }
  .finding-content.collapsed{ max-height:2.5em; overflow:hidden; }
  .finding-expand{ font-size:10px; color:#000082; cursor:pointer; margin-top:2px; }

  /* ---- log ---- */
  .log-row{ display:flex; gap:10px; padding:2px; font-size:11px; }
  .log-row:nth-child(odd){ background:#f4f4ec; }
  .log-time{ color:var(--fg3); flex:none; }
  .log-transition{ flex:none; }
  .log-reason{ color:#1a1a1a; flex:1; word-break:break-word; }
  .log-dur{ color:var(--fg3); flex:none; }

  /* ---- constraints ---- */
  .constraints{ display:flex; flex-direction:column; gap:4px; }
  .constraint{ font-size:11px; color:#1a1a1a; padding:2px 0 2px 8px; border-left:3px solid var(--w-sh); }

  /* ---- toast (mini dialog) ---- */
  .toast{ position:fixed; bottom:42px; right:14px; padding:8px 14px; font-size:11px; z-index:1000;
    background:var(--w-face); color:#000; opacity:0; transition:opacity .2s; pointer-events:none;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh), 2px 2px 0 rgba(0,0,0,.35); }
  .toast.visible{ opacity:1; }
  .toast.success{ border-left:4px solid var(--completed); }
  .toast.error{ border-left:4px solid var(--abandoned); }

  /* ---- taskbar ---- */
  .taskbar{ position:fixed; left:0; right:0; bottom:0; height:32px; z-index:900;
    display:flex; align-items:center; gap:5px; padding:3px 4px;
    background:var(--w-face); border-top:2px solid var(--w-hi);
    box-shadow:inset 0 1px 0 var(--w-lt); }
  .start-btn{ display:flex; align-items:center; gap:5px; font-family:'Tahoma','Segoe UI',Verdana,Geneva,sans-serif;
    font-size:12px; font-weight:700; padding:2px 8px 2px 5px; height:24px; cursor:pointer;
    background:var(--w-face); color:#000;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }
  .start-btn.open{ border-color:var(--w-dk) var(--w-hi) var(--w-hi) var(--w-dk); box-shadow:inset 1px 1px 0 var(--w-sh); }
  .start-logo{ width:18px; height:15px; flex:none; image-rendering:pixelated;
    background:
      linear-gradient(135deg,#ff3b30 0 49%, transparent 49%) 0 0/9px 8px no-repeat,
      linear-gradient(135deg,#34c759 0 49%, transparent 49%) 9px 0/9px 8px no-repeat,
      linear-gradient(135deg,#0a84ff 0 49%, transparent 49%) 0 8px/9px 8px no-repeat,
      linear-gradient(135deg,#ffcc00 0 49%, transparent 49%) 9px 8px/9px 8px no-repeat; }
  .tb-divider{ width:2px; align-self:stretch; margin:2px 2px;
    border-left:1px solid var(--w-sh); border-right:1px solid var(--w-hi); }
  .tb-task{ display:flex; align-items:center; gap:6px; font-size:11px; padding:0 8px; height:24px;
    min-width:160px; background:var(--w-face);
    border:2px solid; border-color:var(--w-dk) var(--w-hi) var(--w-hi) var(--w-dk);
    box-shadow:inset 1px 1px 0 var(--w-sh); }
  .tb-led{ width:9px; height:9px; flex:none; background:#5a5a5a; border:1px solid rgba(0,0,0,.5);
    animation:pulse 1.8s infinite; }
  @keyframes pulse{ 0%,100%{ opacity:1; } 50%{ opacity:.35; } }
  .tray{ margin-left:auto; display:flex; align-items:center; gap:6px; padding:0 8px; height:24px;
    font-size:11px; background:var(--w-face);
    border:2px solid; border-color:var(--w-sh) var(--w-hi) var(--w-hi) var(--w-sh);
    box-shadow:inset 1px 1px 0 var(--w-dk); }
  #tb-clock{ font-variant-numeric:tabular-nums; }

  /* ---- start menu ---- */
  .start-menu{ position:fixed; left:4px; bottom:34px; width:230px; z-index:950; display:none;
    background:var(--w-face); padding:3px;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh), 3px 3px 8px rgba(0,0,0,.4); }
  .start-menu.open{ display:flex; }
  .start-rail{ width:26px; flex:none; margin-right:3px; writing-mode:vertical-rl; transform:rotate(180deg);
    text-align:center; font-weight:700; font-size:15px; letter-spacing:1px; color:#fff; padding:8px 0;
    background:linear-gradient(0deg,#000082,#1084d0); }
  .start-items{ flex:1; display:flex; flex-direction:column; }
  .start-item{ display:flex; align-items:center; gap:8px; padding:5px 10px; font-size:12px; cursor:pointer; color:#000; }
  .start-item:hover{ background:var(--w-navy); color:#fff; }
  .start-item .si-ico{ width:16px; text-align:center; }
  .start-sep{ height:0; border-top:1px solid var(--w-sh); border-bottom:1px solid var(--w-hi); margin:3px 2px; }

  /* ---- chunky scrollbars ---- */
  ::-webkit-scrollbar{ width:17px; height:17px; }
  ::-webkit-scrollbar-track{ background:#dfdfdf;
    background-image:linear-gradient(45deg,#cfcfcf 25%,transparent 25%,transparent 75%,#cfcfcf 75%),
      linear-gradient(45deg,#cfcfcf 25%,transparent 25%,transparent 75%,#cfcfcf 75%);
    background-size:2px 2px; background-position:0 0,1px 1px; }
  ::-webkit-scrollbar-thumb{ background:var(--w-face);
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); }
  ::-webkit-scrollbar-button:single-button{ background:var(--w-face); height:17px; width:17px;
    border:2px solid; border-color:var(--w-hi) var(--w-dk) var(--w-dk) var(--w-hi);
    box-shadow:inset 1px 1px 0 var(--w-lt), inset -1px -1px 0 var(--w-sh); display:block; }
  ::-webkit-scrollbar-corner{ background:var(--w-face); }

  .state-name{ font-family:'MSSS','Tahoma',sans-serif; letter-spacing:1px; }
</style>
</head>
<body>

<div id="desktop">
<div class="grid">

  <div class="window full" id="state-panel">
    <div class="title-bar" ondblclick="winToggle(this)">
      <span class="title-ico"></span><span class="title-cap">Cortex State</span>
      <div class="title-btns">
        <button class="tb-btn" onclick="winToggle(this)" title="Minimize">_</button>
        <button class="tb-btn" title="Maximize">&#9633;</button>
        <button class="tb-btn" onclick="winToggle(this)" title="Close">&times;</button>
      </div>
    </div>
    <div class="window-body">
      <div class="state-banner">
        <div><span class="state-name" id="state-name">base</span> <span class="state-level" id="state-level"></span></div>
        <div class="state-meta" id="state-meta"></div>
      </div>
    </div>
  </div>

  <div class="window full" id="pathway-panel">
    <div class="title-bar" ondblclick="winToggle(this)">
      <span class="title-ico"></span><span class="title-cap">Pathway <span class="sub" id="pathway-name"></span></span>
      <div class="title-btns">
        <button class="tb-btn" onclick="winToggle(this)" title="Minimize">_</button>
        <button class="tb-btn" title="Maximize">&#9633;</button>
        <button class="tb-btn" onclick="winToggle(this)" title="Close">&times;</button>
      </div>
    </div>
    <div class="window-body"><div class="pathway-bar" id="pathway-bar"></div></div>
  </div>

  <div class="window full" id="tools-panel">
    <div class="title-bar" ondblclick="winToggle(this)">
      <span class="title-ico"></span><span class="title-cap">Tools <span class="sub tool-count" id="tool-count"></span></span>
      <div class="title-btns">
        <button class="tb-btn" onclick="winToggle(this)" title="Minimize">_</button>
        <button class="tb-btn" title="Maximize">&#9633;</button>
        <button class="tb-btn" onclick="winToggle(this)" title="Close">&times;</button>
      </div>
    </div>
    <div class="window-body"><div class="well"><div class="tools-grid" id="tools-grid"></div></div></div>
  </div>

  <div class="window full" id="constraints-panel" style="display:none">
    <div class="title-bar" ondblclick="winToggle(this)">
      <span class="title-ico"></span><span class="title-cap">Constraints</span>
      <div class="title-btns">
        <button class="tb-btn" onclick="winToggle(this)" title="Minimize">_</button>
        <button class="tb-btn" title="Maximize">&#9633;</button>
        <button class="tb-btn" onclick="winToggle(this)" title="Close">&times;</button>
      </div>
    </div>
    <div class="window-body"><div class="constraints" id="constraints"></div></div>
  </div>

  <div class="window full" id="timeline-panel">
    <div class="title-bar" ondblclick="winToggle(this)">
      <span class="title-ico"></span><span class="title-cap">State History</span>
      <div class="title-btns">
        <button class="tb-btn" onclick="winToggle(this)" title="Minimize">_</button>
        <button class="tb-btn" title="Maximize">&#9633;</button>
        <button class="tb-btn" onclick="winToggle(this)" title="Close">&times;</button>
      </div>
    </div>
    <div class="window-body"><div class="well"><div class="timeline" id="timeline"></div></div></div>
  </div>

  <div class="window" id="tasks-panel">
    <div class="title-bar" ondblclick="winToggle(this)">
      <span class="title-ico"></span><span class="title-cap">Tasks</span>
      <div class="title-btns">
        <button class="tb-btn" onclick="winToggle(this)" title="Minimize">_</button>
        <button class="tb-btn" title="Maximize">&#9633;</button>
        <button class="tb-btn" onclick="winToggle(this)" title="Close">&times;</button>
      </div>
    </div>
    <div class="toolbar"><button class="w-btn" onclick="toggleNewTaskForm()">New Task</button></div>
    <div class="window-body">
      <div class="new-task-form" id="new-task-form">
        <input id="new-task-title" placeholder="Task title" onkeydown="if(event.key==='Enter')submitNewTask()" />
        <input id="new-task-desc" placeholder="Description (optional)" onkeydown="if(event.key==='Enter')submitNewTask()" />
        <button onclick="submitNewTask()">Create</button>
      </div>
      <div class="well tall"><div id="tasks-list"></div></div>
    </div>
  </div>

  <div class="window" id="findings-panel">
    <div class="title-bar" ondblclick="winToggle(this)">
      <span class="title-ico"></span><span class="title-cap">Findings</span>
      <div class="title-btns">
        <button class="tb-btn" onclick="winToggle(this)" title="Minimize">_</button>
        <button class="tb-btn" title="Maximize">&#9633;</button>
        <button class="tb-btn" onclick="winToggle(this)" title="Close">&times;</button>
      </div>
    </div>
    <div class="window-body"><div class="well tall"><div id="findings-list"></div></div></div>
  </div>

  <div class="window full" id="log-panel">
    <div class="title-bar" ondblclick="winToggle(this)">
      <span class="title-ico"></span><span class="title-cap">Free Explore Log</span>
      <div class="title-btns">
        <button class="tb-btn" onclick="winToggle(this)" title="Minimize">_</button>
        <button class="tb-btn" title="Maximize">&#9633;</button>
        <button class="tb-btn" onclick="winToggle(this)" title="Close">&times;</button>
      </div>
    </div>
    <div class="window-body"><div class="well"><div id="log-list"></div></div></div>
  </div>

</div>
</div>

<div class="start-menu" id="start-menu">
  <div class="start-rail">Cortex&#160;95</div>
  <div class="start-items">
    <div class="start-item" onclick="startGo('about')"><span class="si-ico">&#9432;</span> About Cortex</div>
    <div class="start-sep"></div>
    <div class="start-item" onclick="startGo('tasks-panel')"><span class="si-ico">&#128221;</span> Tasks</div>
    <div class="start-item" onclick="startGo('findings-panel')"><span class="si-ico">&#128270;</span> Findings</div>
    <div class="start-item" onclick="startGo('timeline-panel')"><span class="si-ico">&#9202;</span> State History</div>
    <div class="start-item" onclick="startGo('log-panel')"><span class="si-ico">&#128194;</span> Free Explore Log</div>
    <div class="start-sep"></div>
    <div class="start-item" onclick="startGo('refresh')"><span class="si-ico">&#8635;</span> Refresh</div>
  </div>
</div>

<div class="taskbar">
  <button class="start-btn" id="start-btn" onclick="toggleStart(event)"><span class="start-logo"></span>Start</button>
  <div class="tb-divider"></div>
  <div class="tb-task"><span class="tb-led" id="pulse-dot"></span><span id="tb-state">Cortex - base</span></div>
  <div class="tray"><span id="tb-clock">--:--</span></div>
</div>

<script>
// --- State colors ---
const STATE_COLORS = {
  recon: '#0a0aa0', plan: '#9a0a9a', implement: '#0a7a0a',
  debug: '#9a6a00', validate: '#0a8a0a', review: '#5a5a5a',
  browse: '#0a7a8a', free: '#b02020', base: '#5a5a5a',
  coach: '#a0408a'
};

const STATUS_ICONS = {
  completed: '<span style="color:#3fb950">\\u2713</span>',
  active: '<span style="color:#58a6ff">\\u25c9</span>',
  paused: '<span style="color:#d29922">\\u23f8</span>',
  abandoned: '<span style="color:#f85149">\\u2717</span>',
  blocked: '<span style="color:#f0883e">\\u2298</span>'
};

// --- Tool source mapping ---
function toolSource(name) {
  if (name.startsWith('dd_')) return 'datadog';
  if (name.startsWith('kubectl_')) return 'kubectl';
  if (name.startsWith('mongo_')) return 'mongo';
  if (name.startsWith('browser_') || name === 'browse_capture') return 'playwright';
  if (name.startsWith('brave_')) return 'brave';
  if (name.startsWith('jira_')) return 'jira';
  if (name.startsWith('confluence_')) return 'confluence';
  if (name === 'run_command') return 'commands';
  if (name === 'run_pipeline' || name === 'rerun_workflow') return 'circleci';
  const ghTools = ['get_commit','list_commits','get_file_contents','list_branches','search_code',
    'search_repositories','search_users','get_me','get_teams','get_team_members',
    'list_pull_requests','pull_request_read','search_pull_requests'];
  if (ghTools.includes(name)) return 'github';
  const ciTools = ['get_build_failure_logs','find_flaky_tests','get_latest_pipeline_status',
    'get_job_test_results','list_artifacts','analyze_diff','config_helper',
    'list_followed_projects','download_usage_api_data','find_underused_resource_classes',
    'list_component_versions','create_prompt_template','recommend_prompt_template_tests',
    'run_evaluation_tests','run_rollback_pipeline'];
  if (ciTools.includes(name)) return 'circleci';
  return '';
}

// --- Config + state ---
let config = null;
let prevStateName = null;
let expandedFindings = new Set();
let expandedTasks = new Set(JSON.parse(localStorage.getItem('cortex.expandedTasks') || '[]'));

function toggleTaskExpansion(id) {
  if (expandedTasks.has(id)) expandedTasks.delete(id);
  else expandedTasks.add(id);
  localStorage.setItem('cortex.expandedTasks', JSON.stringify([...expandedTasks]));
  renderTasks(lastState, lastTasks);
}

async function fetchJSON(url) {
  try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
}

// --- Write helpers ---
async function writeTask(id, task) {
  const r = await fetch('/api/write-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, task }) });
  if (!r.ok) throw new Error((await r.json()).error || 'write failed');
}

async function deleteTask(id) {
  const r = await fetch('/api/delete-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  if (!r.ok) throw new Error((await r.json()).error || 'delete failed');
}

function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast visible ' + type;
  setTimeout(() => { el.className = 'toast'; }, 2500);
}

function genId() { return Math.random().toString(16).slice(2, 10); }

// --- Task actions ---
function toggleNewTaskForm() {
  const form = document.getElementById('new-task-form');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) document.getElementById('new-task-title').focus();
}

async function submitNewTask() {
  const titleEl = document.getElementById('new-task-title');
  const descEl = document.getElementById('new-task-desc');
  const title = titleEl.value.trim();
  if (!title) return;
  const active = lastTasks.filter(t => !t.parent && t.status === 'active');
  if (active.length >= 3) { showToast('Max 3 active root tasks', 'error'); return; }
  const id = genId();
  const now = new Date().toISOString();
  const task = { id, title, description: descEl.value.trim(), created: now, updated: now, status: 'active', parent: null, pathway: null, state_history: [], findings: [], subtasks: [] };
  try {
    await writeTask(id, task);
    showToast('Created: ' + title);
    titleEl.value = ''; descEl.value = '';
    document.getElementById('new-task-form').classList.remove('visible');
    pollTasks();
  } catch (e) { showToast(e.message, 'error'); }
}

async function changeTaskStatus(id, status) {
  const task = lastTasks.find(t => t.id === id);
  if (!task) return;
  task.status = status;
  task.updated = new Date().toISOString();
  try { await writeTask(id, task); showToast('Status: ' + status); pollTasks(); }
  catch (e) { showToast(e.message, 'error'); }
}

async function saveTaskTitle(id, el) {
  const newTitle = el.textContent.trim();
  if (!newTitle) return;
  const task = lastTasks.find(t => t.id === id);
  if (!task || task.title === newTitle) return;
  task.title = newTitle;
  task.updated = new Date().toISOString();
  try { await writeTask(id, task); showToast('Title updated'); }
  catch (e) { showToast(e.message, 'error'); pollTasks(); }
}

async function deleteTaskAction(id) {
  if (!confirm('Delete this task?')) return;
  try { await deleteTask(id); showToast('Deleted'); pollTasks(); }
  catch (e) { showToast(e.message, 'error'); }
}

function toggleNoteInput(id) {
  const el = document.getElementById('note-row-' + id);
  if (el) el.classList.toggle('visible');
}

async function addNote(id) {
  const input = document.getElementById('note-input-' + id);
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  const task = lastTasks.find(t => t.id === id);
  if (!task) return;
  task.findings.push({ ts: new Date().toISOString(), state: 'manual', content: '[note] ' + content });
  task.updated = new Date().toISOString();
  try { await writeTask(id, task); showToast('Note added'); input.value = ''; pollTasks(); }
  catch (e) { showToast(e.message, 'error'); }
}

// --- Resolve tools for state + level ---
function resolveTools(stateName, level) {
  if (!config) return [];
  const def = config.states[stateName];
  if (!def) return [];
  if (def.tools) return def.tools;
  if (!def.levels) return [];
  const targetLevel = level || 1;
  let tools = [];
  for (let l = 1; l <= targetLevel; l++) {
    const ld = def.levels[l];
    if (!ld) continue;
    if (ld.tools) tools = [...ld.tools];
    if (ld.additional_tools) tools = [...tools, ...ld.additional_tools];
  }
  return tools;
}

// --- Resolve constraints for state + level ---
function resolveConstraints(stateName, level) {
  if (!config) return [];
  const def = config.states[stateName];
  if (!def) return [];
  if (def.constraints && !def.levels) return def.constraints;
  if (!def.levels) return [];
  const targetLevel = level || 1;
  let constraints = [];
  for (let l = 1; l <= targetLevel; l++) {
    const ld = def.levels[l];
    if (!ld) continue;
    if (ld.constraints) constraints = [...constraints, ...ld.constraints];
  }
  return constraints;
}

// --- Time formatting ---
function fmtDuration(ms) {
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[d.getMonth()] + ' ' + d.getDate();
}

function fmtDateTime(iso) {
  return fmtDate(iso) + ' ' + fmtTime(iso);
}

// --- Render functions ---

function renderState(state) {
  const el = document.getElementById('state-name');
  const stateName = state.current_state || 'base';
  const color = STATE_COLORS[stateName] || STATE_COLORS.base;

  if (prevStateName && prevStateName !== stateName) {
    document.getElementById('state-panel').classList.add('state-flash');
    setTimeout(() => document.getElementById('state-panel').classList.remove('state-flash'), 400);
  }
  prevStateName = stateName;

  el.textContent = stateName;
  el.style.color = color;
  document.getElementById('pulse-dot').style.background = color;
  const _tb = document.getElementById('tb-state');
  if (_tb) _tb.textContent = 'Cortex - ' + stateName + (state.current_level ? ' (L' + state.current_level + ')' : '');
  const _led = document.getElementById('pulse-dot'); if (_led) _led.style.boxShadow = '0 0 3px ' + color;

  const levelEl = document.getElementById('state-level');
  levelEl.textContent = state.current_level ? '(L' + state.current_level + ')' : '';

  const metaEl = document.getElementById('state-meta');
  let meta = '';
  if (state.previous_state) meta += '<span>prev: ' + state.previous_state + '</span>';
  if (state.session_started) {
    const uptime = Date.now() - new Date(state.session_started).getTime();
    meta += '<span>session: ' + fmtDuration(uptime) + '</span>';
  }
  metaEl.innerHTML = meta;
}

function renderPathway(state, tasks) {
  const bar = document.getElementById('pathway-bar');
  const nameEl = document.getElementById('pathway-name');

  const activeTask = state.active_task ? tasks.find(t => t.id === state.active_task) : null;
  const pathwayName = activeTask?.pathway;

  if (!pathwayName || !config?.pathways?.[pathwayName]) {
    nameEl.textContent = '';
    bar.innerHTML = '<span class="pathway-none">no active pathway</span>';
    return;
  }

  const pw = config.pathways[pathwayName];
  nameEl.textContent = '/ ' + pathwayName;

  const visitedStates = new Set((activeTask.state_history || []).map(h => h.state));
  const currentState = state.current_state;

  let html = '';
  pw.sequence.forEach((s, i) => {
    const color = STATE_COLORS[s] || STATE_COLORS.base;
    const isCurrent = s === currentState;
    const isVisited = visitedStates.has(s);
    let cls = 'pathway-step';
    if (isCurrent) cls += ' current';
    else if (isVisited) cls += ' visited';

    const bg = isCurrent ? color : (isVisited ? color + '22' : '');
    const border = isVisited || isCurrent ? '1px solid ' + color : '1px solid transparent';
    html += '<div class="' + cls + '" style="background:' + (bg || 'var(--bg3)') + ';border:' + border + '">' + s + '</div>';
    if (i < pw.sequence.length - 1) html += '<span class="pathway-arrow">&#9656;</span>';
  });

  bar.innerHTML = html;
}

function renderTools(state) {
  const tools = resolveTools(state.current_state, state.current_level);
  document.getElementById('tool-count').textContent = '(' + tools.length + ')';

  const grid = document.getElementById('tools-grid');
  if (!tools.length) { grid.innerHTML = '<span class="empty">no tools in this state</span>'; return; }

  grid.innerHTML = tools.map(t => {
    const src = toolSource(t);
    const srcHtml = src ? ' <span class="src">' + src + '</span>' : '';
    return '<span class="tool-chip">' + t + srcHtml + '</span>';
  }).join('');

  // Constraints
  const constraints = resolveConstraints(state.current_state, state.current_level);
  const cp = document.getElementById('constraints-panel');
  const ce = document.getElementById('constraints');
  if (constraints.length) {
    cp.style.display = '';
    const color = STATE_COLORS[state.current_state] || STATE_COLORS.base;
    ce.innerHTML = constraints.map(c =>
      '<div class="constraint" style="border-left-color:' + color + '">' + escHtml(c) + '</div>'
    ).join('');
  } else {
    cp.style.display = 'none';
  }
}

function renderTimeline(state, tasks) {
  const el = document.getElementById('timeline');
  const activeTask = state.active_task ? tasks.find(t => t.id === state.active_task) : null;
  const history = activeTask?.state_history || [];

  if (!history.length) { el.innerHTML = '<span class="tl-none">no state history</span>'; return; }

  // Deduplicate consecutive same-state entries by merging them
  const merged = [];
  for (const h of history) {
    const last = merged[merged.length - 1];
    if (last && last.state === h.state) {
      last.exited = h.exited;
    } else {
      merged.push({ ...h });
    }
  }

  el.innerHTML = merged.map((h, i) => {
    const color = STATE_COLORS[h.state] || STATE_COLORS.base;
    const entered = new Date(h.entered);
    const exited = h.exited ? new Date(h.exited) : new Date();
    const dur = fmtDuration(exited - entered);
    const isLast = i === merged.length - 1;
    const opacity = isLast && !h.exited ? '1' : '0.7';

    let html = '<div class="tl-segment" style="background:' + color + '18;color:' + color + ';opacity:' + opacity + '">'
      + h.state + ' <span class="dur">' + dur + '</span></div>';
    if (i < merged.length - 1) html += '<span class="tl-arrow">&#9656;</span>';
    return html;
  }).join('');
}

function renderTaskRow(t, activeId) {
  const statuses = ['active', 'paused', 'blocked', 'completed', 'abandoned'];
  const byParent = renderTaskRow._byParent;
  const children = byParent.get(t.id) || [];
  const isActive = t.id === activeId;
  const icon = STATUS_ICONS[t.status] || '';
  const badge = t.pathway ? '<span class="task-badge">' + t.pathway + '</span>' : '';
  const opts = statuses.map(s => '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' + s + '</option>').join('');
  const expanded = expandedTasks.has(t.id);
  const disclosure = children.length
    ? '<span class="task-disclosure" onclick="toggleTaskExpansion(\\'' + t.id + '\\')">' + (expanded ? '&#9662;' : '&#9656;') + '</span>'
    : '<span class="task-disclosure empty">&#9656;</span>';
  const childCount = children.length ? '<span class="task-badge">' + children.length + '</span>' : '';

  let html = '<div class="task-row' + (isActive ? ' highlight' : '') + '">'
    + disclosure
    + '<span class="task-icon">' + icon + '</span>'
    + '<span class="task-title" contenteditable="true" '
    + 'onblur="saveTaskTitle(\\'' + t.id + '\\', this)" '
    + 'onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();this.blur()}"'
    + '>' + escHtml(t.title) + '</span>'
    + badge
    + childCount
    + '<div class="task-actions">'
    + '<select onchange="changeTaskStatus(\\'' + t.id + '\\', this.value)">' + opts + '</select>'
    + '<button onclick="toggleNoteInput(\\'' + t.id + '\\')" title="Add note">+</button>'
    + '<button class="btn-delete" onclick="deleteTaskAction(\\'' + t.id + '\\')" title="Delete">&times;</button>'
    + '</div>'
    + '<span class="task-date">' + fmtDate(t.updated) + '</span>'
    + '</div>'
    + '<div class="inline-note" id="note-row-' + t.id + '">'
    + '<input id="note-input-' + t.id + '" placeholder="Add a note..." '
    + 'onkeydown="if(event.key===\\'Enter\\')addNote(\\'' + t.id + '\\')" />'
    + '<button onclick="addNote(\\'' + t.id + '\\')">Save</button>'
    + '</div>';

  if (children.length && expanded) {
    const sortedKids = [...children].sort((a, b) => new Date(b.updated) - new Date(a.updated));
    html += '<div class="task-children">' + sortedKids.map(c => renderTaskRow(c, activeId)).join('') + '</div>';
  }
  return html;
}

function renderTasks(state, tasks) {
  const el = document.getElementById('tasks-list');
  if (!tasks.length) { el.innerHTML = '<span class="empty">no tasks</span>'; return; }

  const ids = new Set(tasks.map(t => t.id));
  const byParent = new Map();
  for (const t of tasks) {
    const p = t.parent && ids.has(t.parent) ? t.parent : null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(t);
  }
  renderTaskRow._byParent = byParent;

  const roots = (byParent.get(null) || []).sort((a, b) => new Date(b.updated) - new Date(a.updated));
  el.innerHTML = roots.map(t => renderTaskRow(t, state.active_task)).join('');
}

function renderFindings(state, tasks) {
  const el = document.getElementById('findings-list');
  const activeTask = state.active_task ? tasks.find(t => t.id === state.active_task) : null;
  const findings = activeTask?.findings || [];

  if (!findings.length) { el.innerHTML = '<span class="empty">no findings</span>'; return; }

  const recent = [...findings].reverse();
  el.innerHTML = recent.map((f, i) => {
    const color = STATE_COLORS[f.state] || STATE_COLORS.base;
    const expanded = expandedFindings.has(i);
    const content = f.content || '';
    const truncated = content.length > 200 && !expanded;
    return '<div class="finding" data-idx="' + i + '">'
      + '<div class="finding-header">'
      + '<span class="finding-state" style="color:' + color + '">' + f.state + '</span>'
      + '<span class="finding-time">' + fmtTime(f.ts) + '</span>'
      + '</div>'
      + '<div class="finding-content' + (truncated ? ' collapsed' : '') + '">' + escHtml(truncated ? content.slice(0, 200) + '...' : content) + '</div>'
      + (content.length > 200 ? '<div class="finding-expand">' + (expanded ? '[ collapse ]' : '[ expand ]') + '</div>' : '')
      + '</div>';
  }).join('');

  el.querySelectorAll('.finding').forEach(f => {
    f.addEventListener('click', () => {
      const idx = parseInt(f.dataset.idx);
      if (expandedFindings.has(idx)) expandedFindings.delete(idx);
      else expandedFindings.add(idx);
      renderFindings(lastState, lastTasks);
    });
  });
}

function renderLog(log) {
  const el = document.getElementById('log-list');
  if (!log.length) { el.innerHTML = '<span class="empty">no free explore sessions</span>'; return; }

  // Pair entries: open (reason != null, duration == null) + close (reason == null, duration != null)
  const sessions = [];
  for (let i = 0; i < log.length; i++) {
    const entry = log[i];
    if (entry.reason !== null && entry.reason !== undefined) {
      // Look for matching close
      const close = log[i + 1]?.duration_seconds != null ? log[i + 1] : null;
      sessions.push({
        time: entry.timestamp,
        from: entry.from_state || entry.from_mode || '?',
        reason: entry.reason,
        duration: close?.duration_seconds,
        task: entry.task_id
      });
      if (close) i++;
    }
  }

  const recent = sessions.reverse();
  el.innerHTML = recent.map(s => {
    const fromColor = STATE_COLORS[s.from] || STATE_COLORS.base;
    return '<div class="log-row">'
      + '<span class="log-time">' + fmtDateTime(s.time) + '</span>'
      + '<span class="log-transition"><span style="color:' + fromColor + '">' + s.from + '</span> &#8594; free</span>'
      + (s.duration != null ? '<span class="log-dur">' + s.duration + 's</span>' : '')
      + '<span class="log-reason">' + escHtml(s.reason || '') + '</span>'
      + '</div>';
  }).join('');
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Polling ---

let lastState = {};
let lastTasks = [];

async function pollState() {
  const state = await fetchJSON('/api/state');
  if (!state) return;
  lastState = state;
  renderState(state);
  renderPathway(state, lastTasks);
  renderTools(state);
  renderTimeline(state, lastTasks);
  renderFindings(state, lastTasks);
}

async function pollTasks() {
  const tasks = await fetchJSON('/api/tasks');
  if (!tasks) return;
  lastTasks = tasks;
  // Skip re-render if user is editing inside the tasks panel
  const active = document.activeElement;
  const tasksPanel = document.getElementById('tasks-panel');
  if (!(active && tasksPanel && tasksPanel.contains(active))) {
    renderTasks(lastState, tasks);
  }
  renderPathway(lastState, tasks);
  renderTimeline(lastState, tasks);
  renderFindings(lastState, tasks);
}

async function pollLog() {
  const log = await fetchJSON('/api/log');
  if (!log) return;
  renderLog(log);
}

// --- Win95 chrome behaviour ---
function winToggle(el){ const w = el.closest('.window'); if (w) w.classList.toggle('collapsed'); }
function toggleStart(e){ if (e) e.stopPropagation();
  const m = document.getElementById('start-menu'), b = document.getElementById('start-btn');
  const open = m.classList.toggle('open'); b.classList.toggle('open', open); }
function closeStart(){ const m = document.getElementById('start-menu'), b = document.getElementById('start-btn');
  if (m) m.classList.remove('open'); if (b) b.classList.remove('open'); }
function startGo(what){
  closeStart();
  if (what === 'about'){ showToast('Cortex: executive function layer for coding agents'); return; }
  if (what === 'refresh'){ pollState(); pollTasks(); pollLog(); showToast('Refreshed'); return; }
  const el = document.getElementById(what);
  if (el){ el.classList.remove('collapsed'); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}
document.addEventListener('click', (e) => {
  const m = document.getElementById('start-menu'), b = document.getElementById('start-btn');
  if (m && m.classList.contains('open') && !m.contains(e.target) && b && !b.contains(e.target)) closeStart();
});
function updateClock(){
  const el = document.getElementById('tb-clock'); if (!el) return;
  el.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
updateClock(); setInterval(updateClock, 15000);


// --- Init ---
async function init() {
  config = await fetchJSON('/api/config');
  await Promise.all([pollState(), pollTasks(), pollLog()]);
  setInterval(pollState, 1000);
  setInterval(pollTasks, 3000);
  setInterval(pollLog, 5000);
}

init();
</script>
<div class="toast" id="toast"></div>
</body>
</html>`;

// --- Server ---

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) return handleApi(req, url, res);
  if (url === '/' || url === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(HTML);
  }
  res.statusCode = 404;
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Cortex Dashboard: http://localhost:${PORT}`);
});
