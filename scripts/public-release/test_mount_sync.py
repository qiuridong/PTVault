import sys
import unittest
if sys.platform=='linux':
    from mount_sync import desired_mounts
    from lifecycle_lib import InstallError

@unittest.skipUnless(sys.platform=='linux','Linux root helper module')
class MountSyncTest(unittest.TestCase):
    def fixture(self):
        identifier='00000000-0000-4000-8000-000000000001'
        return {'version':1,'slots':[{'accountId':identifier,'slot':3}],
                'desired':{'enabled':True,'accounts':[{'id':identifier,'cryptRemote':'fixture_crypt:'}],'cacheMaxBytes':4096,'reserveBytes':1024}}

    def test_uuid_ports_and_remote_suffix_are_fixed(self):
        value=desired_mounts(self.fixture())
        self.assertEqual([x['port'] for x in value],[34806,34807])
        self.assertEqual([x['kind'] for x in value],['media','imports'])
        self.assertEqual([x['cacheBytes'] for x in value],[4096,0])
        for field,bad in [('cryptRemote','x: /etc'),('cryptRemote','x:\nINJECT=1'),('id','../../outside')]:
            fixture=self.fixture(); fixture['desired']['accounts'][0][field]=bad
            with self.assertRaisesRegex(InstallError,'MOUNT_REGISTRY_INVALID'): desired_mounts(fixture)

    def test_disabled_duplicate_and_unbounded_allocations_fail_safely(self):
        for mutate in [lambda v:v['slots'].append(v['slots'][0]),lambda v:v['slots'][0].update(slot=True),lambda v:v['slots'][0].update(slot=512),lambda v:v['desired'].update(enabled=False),lambda v:v['desired'].update(cacheMaxBytes=-1)]:
            fixture=self.fixture(); mutate(fixture)
            with self.assertRaisesRegex(InstallError,'MOUNT_REGISTRY_INVALID'): desired_mounts(fixture)
        fixture=self.fixture(); fixture['desired'].update(enabled=False,accounts=[])
        self.assertEqual(desired_mounts(fixture),[])

if __name__=='__main__': unittest.main()
