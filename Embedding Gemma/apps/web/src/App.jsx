import EmbeddingTester from './components/EmbeddingTester.jsx';

export default function App() {
  return (
    <div className="page">
      <header>
        <h1>FotoFlow AI Playground</h1>
        <p>Isolated Gemini-embedding experiments — no production data.</p>
      </header>
      <main>
        <EmbeddingTester />
      </main>
      <footer>
        <span>M1 foundation + M2 single-image test · API key stays in services/api only</span>
      </footer>
    </div>
  );
}
