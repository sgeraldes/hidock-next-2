/* FUN_0104f52c @ 0104f52c body=[[0104f52c, 0104f623]] */

uint FUN_0104f52c(int param_1,uint param_2,undefined4 param_3)

{
  ushort *puVar1;
  char *pcVar2;
  int iVar3;
  uint uVar4;
  uint local_18;
  
  pcVar2 = DAT_0104f628;
  puVar1 = DAT_0104f624;
  if ((param_1 == 0) && (param_2 == 0)) {
    FUN_0106a7e4(0,0,&local_18);
  }
  else {
    for (; param_2 != 0; param_2 = param_2 - local_18) {
      iVar3 = FUN_0108fde4(DAT_0104f62c,param_3);
      if (iVar3 != 0) {
        FUN_0106a7fe();
        if (0 < *DAT_0104f630) {
          FUN_0104ba04(PTR_s___s__s__s___stimeout_s_0104f640,PTR_s_usb_iap2_hal_0104f63c,
                       PTR_s__ERR__0104f638,PTR_s_usb_iap2_drv_ep_read_0104f644,
                       PTR_s__010f8ede_0x1b_0104f634,PTR_s__010f8ede_0x1b_0104f634);
        }
        return 0xffffffb1;
      }
      if (*pcVar2 != '\x03') {
        FUN_0106a7fe();
        if (0 < *DAT_0104f630) {
          FUN_0104ba04(PTR_s___s__s__s___sstatus___d_s_0104f648,PTR_s_usb_iap2_hal_0104f63c,
                       PTR_s__ERR__0104f638,PTR_s_usb_iap2_drv_ep_read_0104f644,
                       PTR_s__010f8ede_0x1b_0104f634,*pcVar2,PTR_s__010f8ede_0x1b_0104f634);
        }
        return 0xffffffed;
      }
      uVar4 = (uint)*puVar1;
      if (param_2 < *puVar1) {
        uVar4 = param_2;
      }
      iVar3 = FUN_0106a7e4(param_1,uVar4,&local_18);
      if (iVar3 != 0) {
        if (0 < *DAT_0104f630) {
          FUN_0104ba04(PTR_s___s__s__s___serr_ret___d_s_0104f64c,PTR_s_usb_iap2_hal_0104f63c,
                       PTR_s__ERR__0104f638,PTR_s_usb_iap2_drv_ep_read_0104f644,
                       PTR_s__010f8ede_0x1b_0104f634,iVar3,PTR_s__010f8ede_0x1b_0104f634);
        }
        return 0xfffffffb;
      }
      if ((uVar4 != local_18) && (1 < *DAT_0104f630)) {
        FUN_0104ba04(PTR_s___s__s__s___slen___d__read___d_s_0104f650,PTR_s_usb_iap2_hal_0104f63c,
                     PTR_s__WRN__0104f654,PTR_s_usb_iap2_drv_ep_read_0104f644,
                     PTR_s__010f8ede_0x1b_0104f634,uVar4,local_18,PTR_s__010f8ede_0x1b_0104f634);
      }
      param_1 = param_1 + local_18;
    }
    local_18 = 0;
  }
  return local_18;
}


/* FUN_0104f6a0 @ 0104f6a0 body=[[0104f6a0, 0104f703]] */

int FUN_0104f6a0(void)

{
  undefined *puVar1;
  undefined *puVar2;
  int iVar3;
  int iVar4;
  
  iVar3 = FUN_0106a48c(0);
  if (iVar3 == 0) {
    iVar3 = FUN_0106a474(PTR_LAB_0104f71c);
    puVar2 = PTR_LAB_0104f72c;
    puVar1 = PTR_LAB_0104f728;
    if (iVar3 == 0) {
      *DAT_0104f724 = 0x40;
      FUN_0106a460(puVar2,puVar1);
      return 0;
    }
    iVar4 = *DAT_0104f704;
    puVar1 = PTR_s___s__s__s___sregister_status_cb_f_0104f720;
  }
  else {
    iVar4 = *DAT_0104f704;
    puVar1 = PTR_s___s__s__s___sinit_fail_s_0104f714;
  }
  if (0 < iVar4) {
    FUN_0104ba04(puVar1,PTR_s_usb_iap2_hal_0104f710,PTR_s__ERR__0104f70c,
                 PTR_s_usb_iap2_drv_init_0104f718,PTR_s__010f8ede_0x1b_0104f708,
                 PTR_s__010f8ede_0x1b_0104f708);
  }
  return iVar3;
}


