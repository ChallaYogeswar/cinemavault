self.onmessage = function (event) {
  const { requestId, query, dataset, activeFilter, activeSort } = event.data;
  const normalizedQuery = (query || '').trim().toLowerCase();

  const results = dataset.filter(function (movie) {
    const title = String(movie.title || '').toLowerCase();
    const genre = String(movie.genre || '').toLowerCase();
    const matchesQuery = !normalizedQuery || title.includes(normalizedQuery) || genre.includes(normalizedQuery);
    const matchesFilter = activeFilter === 'watched' ? movie.watched : activeFilter === 'unwatched' ? !movie.watched : true;
    return matchesQuery && matchesFilter;
  });

  results.sort(function (a, b) {
    if (activeSort === 'year') return String(b.year || '').localeCompare(String(a.year || ''));
    if (activeSort === 'runtime') return runtimeMinutes(b.runtime) - runtimeMinutes(a.runtime);
    if (activeSort === 'genre') return String(a.genre || '').localeCompare(String(b.genre || ''));
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

  self.postMessage({ requestId: requestId, results: results });
};

function runtimeMinutes(runtime) {
  const value = String(runtime || '');
  const hours = Number((value.match(/(\d+)\s*h/i) || [0, 0])[1]);
  const minutes = Number((value.match(/(\d+)\s*m/i) || [0, 0])[1]);
  return hours * 60 + minutes;
}
