import axios from 'axios';

describe('OpenSign Parse Server', () => {
  Parse.User.enableUnsafeCurrentUser();

  it('loads OpenSign cloud functions', async () => {
    const result = await Parse.Cloud.run('checkadminexist');
    expect(result).toBe('not_exist');
  });

  it('blocks public class creation', async () => {
    const obj = new Parse.Object('Test');
    try {
      await obj.save();
      fail('should not have been able to save test object.');
    } catch (e) {
      expect(e).toBeDefined();
      expect(e.code).toBe(Parse.Error.OPERATION_FORBIDDEN);
      expect(e.message).toBe('Permission denied');
    }
  });

  it('serves the OpenSign root route', async () => {
    const { data, headers } = await axios.get('http://localhost:30001/');
    expect(headers['content-type']).toContain('text/html');
    expect(data).toBe('opensign-server is running !!!');
  });
});
