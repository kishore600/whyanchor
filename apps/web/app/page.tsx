export default function Home() {
  return (
    <main>
      <h1>whyanchor</h1>
      <p className="lede">
        A memory layer for AI coding agents. The reasons behind your code live in your repo, are anchored to the
        exact files and functions they explain, and are flagged when that code changes.
      </p>
      <p>
        The hosted team version is in development. The open-source CLI works today:
      </p>
      <pre>
        <code>npx whyanchor</code>
      </pre>
      <p>
        <a href="https://github.com/kishore600/whyanchor">github.com/kishore600/whyanchor</a>
      </p>
    </main>
  );
}
