import { configureStore } from '@reduxjs/toolkit';
import embeddingReducer from './embeddingSlice.js';

export const store = configureStore({
  reducer: {
    embedding: embeddingReducer,
  },
});
