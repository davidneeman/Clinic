import { dayIndex, fromMinutes, toMinutes, weekday } from './time.js';

/**
 * Free start times ("HH:MM") for one day.
 *
 * @param {object} p
 * @param {string} p.date          "YYYY-MM-DD" in the practice's time zone
 * @param {number} p.duration      session length in minutes
 * @param {object} p.schedule      { weeklyHours, slotInterval, bufferMinutes, minNoticeHours, maxDaysAhead }
 * @param {{start:number,end:number}[]} [p.dayBookings]  existing bookings that day, in minutes
 * @param {boolean} [p.blocked]    whole day blocked (vacation, holiday…)
 * @param {{date:string,minutes:number}} p.now  current local date/time
 */
export function slotsForDay({ date, duration, schedule, dayBookings = [], blocked = false, now }) {
  if (blocked) return [];

  const today = dayIndex(now.date);
  const day = dayIndex(date);
  if (day < today || day > today + schedule.maxDaysAhead) return [];

  const earliest = today * 1440 + now.minutes + schedule.minNoticeHours * 60;
  const buffer = schedule.bufferMinutes;
  const ranges = schedule.weeklyHours[String(weekday(date))] || [];
  const slots = new Set();

  for (const [from, to] of ranges) {
    const end = toMinutes(to);
    for (let t = toMinutes(from); t + duration <= end; t += schedule.slotInterval) {
      if (day * 1440 + t < earliest) continue;
      const clash = dayBookings.some((b) => t < b.end + buffer && b.start < t + duration + buffer);
      if (!clash) slots.add(t);
    }
  }
  // In order, and each time once, even when two ranges of hours overlap.
  return [...slots].sort((a, b) => a - b).map(fromMinutes);
}
