import { configureStore } from '@reduxjs/toolkit';
import embeddingReducer from './embeddingSlice.js';
import batchReducer from './batchSlice.js';

export const store = configureStore({
  reducer: {
    embedding: embeddingReducer,
    batch: batchReducer,
  },
});
