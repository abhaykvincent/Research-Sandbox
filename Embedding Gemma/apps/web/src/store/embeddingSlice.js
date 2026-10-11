import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

const API_URL = import.meta.env.VITE_API_URL || '';

export const checkHealth = createAsyncThunk('embedding/checkHealth', async () => {
  const res = await fetch(`${API_URL}/api/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
});

export const embedImage = createAsyncThunk(
  'embedding/embedImage',
  async ({ file, outputDimensionality, includeVector }, { rejectWithValue }) => {
    try {
      const form = new FormData();
      form.append('image', file);
      if (outputDimensionality) form.append('outputDimensionality', String(outputDimensionality));
      if (includeVector) form.append('includeVector', 'true');
      const res = await fetch(`${API_URL}/api/embeddings`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Embedding failed: ${res.status}`);
      return { ...data, fileName: file.name };
    } catch (err) {
      return rejectWithValue(err.message);
    }
  },
);

const embeddingSlice = createSlice({
  name: 'embedding',
  initialState: {
    health: null,
    healthStatus: 'idle',
    jobs: [],
    current: null,
    status: 'idle',
    error: null,
  },
  reducers: {
    clearCurrent(state) {
      state.current = null;
      state.status = 'idle';
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(checkHealth.fulfilled, (state, action) => {
        state.health = action.payload;
        state.healthStatus = 'succeeded';
      })
      .addCase(checkHealth.rejected, (state) => {
        state.healthStatus = 'failed';
      })
      .addCase(embedImage.pending, (state) => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(embedImage.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.current = action.payload;
        state.jobs.unshift(action.payload);
      })
      .addCase(embedImage.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload;
      });
  },
});

export const { clearCurrent } = embeddingSlice.actions;
export default embeddingSlice.reducer;
