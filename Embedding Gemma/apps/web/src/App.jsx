import EmbeddingTester from './components/EmbeddingTester.jsx';
import BatchProcessor from './components/BatchProcessor.jsx';
import EmbeddingInspector from './components/EmbeddingInspector.jsx';
import ClusteringExperiment from './components/ClusteringExperiment.jsx';

export default function App() {
  return (
    <div className="page">
      <header>
        <h1>FotoFlow AI Playground</h1>
        <p>Isolated Gemini-embedding experiments — no production data.</p>
      </header>
      <main>
        <EmbeddingTester />
        <BatchProcessor />
        <EmbeddingInspector />
        <ClusteringExperiment />
      </main>
      <footer>
        <span>M1–M5 · API key stays in services/api only · mock: MOCK_EMBEDDINGS=1</span>
      </footer>
    </div>
  );
}
