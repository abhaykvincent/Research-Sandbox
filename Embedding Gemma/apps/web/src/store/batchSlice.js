import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { blog } from '../utils/debugLog.js';

const API_URL = import.meta.env.VITE_API_URL || '';
const LAST_BATCH_KEY = 'fotoflow-last-batch';

export const createBatch = createAsyncThunk(
  'batch/create',
  async ({ files, outputDimensionality = 768, concurrency = 4, maxRetries = 2 }, { rejectWithValue }) => {
    const t0 = performance.now();
    blog.group(`upload ${files.length} files (dims=${outputDimensionality}, conc=${concurrency})`, () => {
      console.log('files:', files.map((f) => ({ name: f.name, kb: (f.size / 1024).toFixed(1), type: f.type })));
      console.log('API:', `${API_URL}/api/batch-jobs`);
    });
    try {
      const form = new FormData();
      files.forEach((f) => form.append('images', f, f.name));
      form.append('outputDimensionality', String(outputDimensionality));
      form.append('concurrency', String(concurrency));
      form.append('maxRetries', String(maxRetries));
      blog.log('POST /api/batch-jobs → sending…');
      const res = await fetch(`${API_URL}/api/batch-jobs`, { method: 'POST', body: form });
      const data = await res.json().catch((e) => ({ _parseError: String(e) }));
      blog.log(`POST /api/batch-jobs ← ${res.status} in ${Math.round(performance.now() - t0)}ms`, data);
      if (!res.ok && res.status !== 202) throw new Error(data.error || `Batch failed: ${res.status}`);
      localStorage.setItem(LAST_BATCH_KEY, data.batchId);
      return data;
    } catch (err) {
      blog.error('createBatch FAILED', { error: err.message, api: `${API_URL}/api/batch-jobs` });
      return rejectWithValue(err.message);
    }
  },
);

export const fetchBatch = createAsyncThunk('batch/fetch', async (batchId, { rejectWithValue }) => {
  const t0 = performance.now();
  try {
    const res = await fetch(`${API_URL}/api/batch-jobs/${batchId}`);
    const data = await res.json().catch((e) => ({ _parseError: String(e) }));
    if (!res.ok) throw new Error(data.error || `Fetch failed: ${res.status}`);
    const items = data.items ?? [];
    blog.log(`poll ${batchId.slice(0, 8)} ← ${data.status} ok=${data.completed}/${data.total} failed=${data.failed} pending=${data.pending} in ${Math.round(performance.now() - t0)}ms`);
    const failed = items.filter((i) => i.status === 'failed');
    if (failed.length) blog.warn(`${failed.length} items failed`, failed.map((i) => ({ file: i.fileName, error: i.error, attempts: i.attempts })));
    return data;
  } catch (err) {
    blog.error('fetchBatch FAILED', { batchId: batchId?.slice(0, 8), error: err.message });
    return rejectWithValue(err.message);
  }
});

export const retryBatch = createAsyncThunk('batch/retry', async (batchId, { rejectWithValue, dispatch }) => {
  blog.log(`POST /api/batch-jobs/${batchId.slice(0, 8)}/retry → sending…`);
  try {
    const res = await fetch(`${API_URL}/api/batch-jobs/${batchId}/retry`, { method: 'POST' });
    const data = await res.json().catch((e) => ({ _parseError: String(e) }));
    blog.log(`retry ← ${res.status}`, data);
    if (!res.ok) throw new Error(data.error || `Retry failed: ${res.status}`);
    dispatch(fetchBatch(batchId));
    return data;
  } catch (err) {
    blog.error('retryBatch FAILED', { error: err.message });
    return rejectWithValue(err.message);
  }
});

const batchSlice = createSlice({
  name: 'batch',
  initialState: {
    batchId: localStorage.getItem(LAST_BATCH_KEY) || null,
    batch: null,
    status: 'idle', // idle | uploading | polling | succeeded | completed_with_errors | failed
    error: null,
    polling: false,
  },
  reducers: {
    setBatchId(state, action) {
      state.batchId = action.payload;
      localStorage.setItem(LAST_BATCH_KEY, action.payload);
    },
    clearBatch(state) {
      state.batch = null;
      state.status = 'idle';
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createBatch.pending, (state) => { state.status = 'uploading'; state.error = null; })
      .addCase(createBatch.fulfilled, (state, action) => {
        state.batchId = action.payload.batchId;
        state.status = 'polling';
        state.polling = true;
      })
      .addCase(createBatch.rejected, (state, action) => { state.status = 'failed'; state.error = action.payload; })
      .addCase(fetchBatch.fulfilled, (state, action) => {
        state.batch = action.payload;
        if (['succeeded', 'completed_with_errors', 'failed'].includes(action.payload.status)) {
          state.status = action.payload.status;
          state.polling = false;
        } else {
          state.status = 'polling';
          state.polling = true;
        }
      })
      .addCase(fetchBatch.rejected, (state, action) => { state.error = action.payload; state.polling = false; })
      .addCase(retryBatch.fulfilled, (state) => { state.status = 'polling'; state.polling = true; })
      .addCase(retryBatch.rejected, (state, action) => { state.error = action.payload; });
  },
});

export const { setBatchId, clearBatch } = batchSlice.actions;
export default batchSlice.reducer;
