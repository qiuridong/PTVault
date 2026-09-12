import contextlib
import pathlib
import types
import unittest
from unittest import mock

import install


class FirstInstallOrderTest(unittest.TestCase):
    def test_initialize_empty_state_before_creating_media_cache_and_before_service_start(self):
        events=[]
        account=types.SimpleNamespace(pw_uid=999,pw_gid=999)
        with contextlib.ExitStack() as stack:
            for name in ['create_directory','create_master_key','switch_release','install_files','save_marker']:
                stack.enter_context(mock.patch.object(install,name))
            stack.enter_context(mock.patch.object(install,'user_identity',return_value=account))
            stack.enter_context(mock.patch.object(install,'stage',return_value=pathlib.Path('/fixture/release')))
            stack.enter_context(mock.patch.object(install,'run_cli',side_effect=lambda *args:events.append('init')))
            stack.enter_context(mock.patch.object(install,'prepare_media_directories',side_effect=lambda *args:events.append('media')))
            stack.enter_context(mock.patch.object(install,'start_components',side_effect=lambda:events.append('start')))
            install.finish_first_install(pathlib.Path('/fixture/source'),{},3251)
        self.assertEqual(events,['init','media','start'])


if __name__=='__main__': unittest.main()
