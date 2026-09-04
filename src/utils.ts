export function formatDate(date: number): string {
  return new Date(date).toISOString().substring(0, 10)
}
