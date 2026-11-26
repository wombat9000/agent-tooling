import { loadProfile } from './service';
import { makeTestProfile } from './profile-test-fixtures';
import { createMockProfileTransport } from './__tests__/mock-profile-transport';
export const testFixture = createMockProfileTransport(makeTestProfile());
export const subject = loadProfile;
