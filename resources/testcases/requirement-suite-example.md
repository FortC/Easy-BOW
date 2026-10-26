# TESTSUITE: 后台客户管理
- 验收点: AC-CUSTOMER-01, AC-CUSTOMER-02

# TESTCASE: 新建客户
- 需求: REQ-CUSTOMER
- 验收点: AC-CUSTOMER-01

## 测试数据
| 变量 | 值 |
|---|---|
| customer_name | 自动化测试客户_请使用每次唯一值 |

## 准备
### 打开客户列表
- 操作: 访问 {{base_url}}/customers
- 预期: [URL] 包含 /customers

## 步骤
### 新建客户
- 操作: 点击「新建客户」，在「客户名称」填写 {{customer_name}}，点击「保存」
- 预期: [待确认] 按实际需求补充创建成功的页面文案或稳定选择器

## 清理
### 删除测试记录
- 操作: 搜索 {{customer_name}}，仅删除本次测试创建的客户
- 预期: [待确认] 补充删除结果的稳定断言

# TESTCASE: 客户名称必填校验
- 需求: REQ-CUSTOMER
- 验收点: AC-CUSTOMER-02

## 准备
### 打开客户列表
- 操作: 访问 {{base_url}}/customers
- 预期: [URL] 包含 /customers

## 步骤
### 验证空名称
- 操作: 点击「新建客户」，不填写客户名称，点击「保存」
- 预期: [待确认] 补充需求规定的必填提示文案

## 清理
### 关闭新建窗口
- 操作: 取消并关闭新建客户窗口
