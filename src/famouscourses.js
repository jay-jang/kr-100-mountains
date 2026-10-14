export function courseMatches(m, course, query) {
  const text = [m.name, m.name_full, m.region, m.location, course.name,
    course.selection_reason, course.highlight, ...(course.via || [])].filter(Boolean).join(' ').toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
}

