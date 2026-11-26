import { loadProfile } from '../features/profile/service';
export function loader(id: string) {
  return loadProfile(id);
}
